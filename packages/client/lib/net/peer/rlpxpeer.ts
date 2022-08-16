import {
  ETH as Devp2pETH,
  LES as Devp2pLES,
  RLPx as Devp2pRLPx,
  SNAP as Devp2pSNAP,
} from '@ethereumjs/devp2p'
import { isTruthy } from '@ethereumjs/util'
import { randomBytes } from 'crypto'

import { Event } from '../../types'
import { RlpxSender } from '../protocol'

import { Peer } from './peer'

import type { Protocol } from '../protocol'
import type { RlpxServer } from '../server'
import type { PeerOptions } from './peer'
import type { Capabilities as Devp2pCapabilities, Peer as Devp2pRlpxPeer } from '@ethereumjs/devp2p'
const devp2pCapabilities: any = {
  snap1: Devp2pSNAP.snap,
  eth66: Devp2pETH.eth66,
  les2: Devp2pLES.les2,
  les3: Devp2pLES.les3,
  les4: Devp2pLES.les4,
}

export interface RlpxPeerOptions extends Omit<PeerOptions, 'address' | 'transport'> {
  /* Peer hostname or ip address */
  host: string

  /* Peer port */
  port: number
}

/**
 * Devp2p/RLPx peer
 * @memberof module:net/peer
 * @example
 * ```typescript
 * import { RlpxPeer } from './lib/net/peer'
 * import { Chain } from './lib/blockchain'
 * import { EthProtocol } from './lib/net/protocol'
 *
 * const chain = new Chain()
 * const protocols = [ new EthProtocol({ chain })]
 * const id = '70180a7fcca96aa013a3609fe7c23cc5c349ba82652c077be6f05b8419040560a622a4fc197a450e5e2f5f28fe6227637ccdbb3f9ba19220d1fb607505ffb455'
 * const host = '192.0.2.1'
 * const port = 12345
 *
 * new RlpxPeer({ id, host, port, protocols })
 *   .on('error', (err) => console.log('Error:', err))
 *   .on('connected', () => console.log('Connected'))
 *   .on('disconnected', (reason) => console.log('Disconnected:', reason))
 *   .connect()
 * ```
 */
export class RlpxPeer extends Peer {
  private host: string
  private port: number
  public rlpx: Devp2pRLPx | null
  public rlpxPeer: Devp2pRlpxPeer | null
  public connected: boolean

  /**
   * Create new devp2p/rlpx peer
   */
  constructor(options: RlpxPeerOptions) {
    const address = `${options.host}:${options.port}`
    super({
      ...options,
      transport: 'rlpx',
      address,
    })

    this.host = options.host
    this.port = options.port
    this.rlpx = null
    this.rlpxPeer = null
    this.connected = false
  }

  /**
   * Return devp2p/rlpx capabilities for the specified protocols
   * @param protocols protocol instances
   */
  static capabilities(protocols: Protocol[]): Devp2pCapabilities[] {
    const capabilities: Devp2pCapabilities[] = []
    protocols.forEach((protocol) => {
      const { name, versions } = protocol
      const keys = versions.map((v: number) => name + String(v))
      keys.forEach((key: any) => {
        const capability = devp2pCapabilities[key]
        if (isTruthy(capability)) {
          capabilities.push(capability)
        }
      })
    })
    return capabilities
  }

  /**
   * Initiate peer connection
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return
    }
    const key = randomBytes(32)
    await Promise.all(this.protocols.map((p) => p.open()))
    this.rlpx = new Devp2pRLPx(key, {
      capabilities: RlpxPeer.capabilities(this.protocols),
      common: this.config.chainCommon,
    })
    await this.rlpx.connect({
      id: Buffer.from(this.id, 'hex'),
      address: this.host,
      tcpPort: this.port,
    })

    const peerErrorHandler = (_: Devp2pRlpxPeer, error: Error) => {
      this.config.events.emit(Event.PEER_ERROR, error, this)
    }
    const peerErrorHandlerBound = peerErrorHandler.bind(this)
    const peerAddedHandler = async (rlpxPeer: Devp2pRlpxPeer) => {
      try {
        await this.bindProtocols(rlpxPeer)
        this.config.events.emit(Event.PEER_CONNECTED, this)
      } catch (error: any) {
        this.config.events.emit(Event.PEER_ERROR, error, this)
      }
    }
    const peerRemovedHandler = (rlpxPeer: Devp2pRlpxPeer) => {
      if (rlpxPeer !== this.rlpxPeer) {
        return
      }
      this.rlpxPeer = null
      this.connected = false
      this.config.events.emit(Event.PEER_DISCONNECTED, this)
      this.rlpx?.removeListener('peer:error', peerErrorHandlerBound)
    }
    this.rlpx.on('peer:error', peerErrorHandlerBound)
    this.rlpx.once('peer:added', peerAddedHandler.bind(this))
    this.rlpx.once('peer:removed', peerRemovedHandler.bind(this))
  }

  /**
   * Accept new peer connection from an rlpx server
   */
  async accept(rlpxPeer: Devp2pRlpxPeer, server: RlpxServer): Promise<void> {
    if (this.connected) {
      return
    }
    await this.bindProtocols(rlpxPeer)
    this.server = server
  }

  /**
   * Adds protocols to this peer given an rlpx native peer instance.
   * @param rlpxPeer rlpx native peer
   */
  private async bindProtocols(rlpxPeer: Devp2pRlpxPeer): Promise<void> {
    this.rlpxPeer = rlpxPeer
    await Promise.all(
      rlpxPeer.getProtocols().map((rlpxProtocol) => {
        const name = rlpxProtocol.constructor.name.toLowerCase()
        const protocol = this.protocols.find((p) => p.name === name)
        // Since snap is running atop/besides eth, it doesn't need a separate sender
        // handshake, and can just use the eth handshake
        if (protocol !== undefined && name !== 'snap') {
          const sender = new RlpxSender(rlpxProtocol)
          return this.bindProtocol(protocol, sender).then(() => {
            if (name === 'eth') {
              const snapRlpxProtocol = rlpxPeer
                .getProtocols()
                .filter((p) => p.constructor.name.toLowerCase() === 'snap')[0]
              const snapProtocol =
                snapRlpxProtocol !== undefined
                  ? this.protocols.find(
                      (p) => p.name === snapRlpxProtocol?.constructor.name.toLowerCase()
                    )
                  : undefined
              if (snapProtocol !== undefined) {
                const snapSender = new RlpxSender(snapRlpxProtocol)
                return this.bindProtocol(snapProtocol, snapSender)
              }
            }
          })
        }
      })
    )
    this.connected = true
  }
}

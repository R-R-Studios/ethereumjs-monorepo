import { Chain, Common, Hardfork } from '@ethereumjs/common'
import debug from 'debug'
import * as tape from 'tape'

import { EVM } from '../src'

import { getEEI } from './utils'

tape('Tests EVM constructor option to disable command line debugging output', (test) => {
  const it = test.test
  it('Should default to DEBUG: true', async (t) => {
    debug.enable('evm')
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Constantinople })
    const eei = await getEEI()
    const evm = await EVM.create({ eei, common })
    t.ok(evm.DEBUG, 'DEBUG defaults to true')
    t.end()
  })
  it('Should set DEBUG: false from `deactivateCLDebug: true` constructor option', async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Constantinople })
    const eei = await getEEI()
    const evm = await EVM.create({ eei, common, deactivateCLDebug: true })
    t.notok(evm.DEBUG, 'DEBUG set to false')
    t.end()
  })
  test.end()
})

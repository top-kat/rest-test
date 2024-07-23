#!/usr/bin/env node

import argv from 'argv'
import { intro } from './src/rest-test-ascii-display'
import Path from 'path'

import { C } from 'topkat-utils'
import { execWaitForOutput } from 'topkat-utils/backend'

// eslint-disable-next-line no-console
console.log(intro) // do not use C because it adds padding

process.env.NODE_ENV = 'test'


const { options: cliOptions } = argv.option([{
    name: 'configPath',
    type: 'string'
}, {
    name: 'testFlowPath',
    type: 'string'
}, {
    name: 'filter',
    type: 'string'
}, {
    name: 'ci',
    type: 'boolean'
}]).run()


let lastTestNb = 0

export default async function runTestFlow(startAtTestNb?: number) {
    try {

        const nodeModuleDir = __dirname
        const childProcessDir = Path.join(nodeModuleDir, './dist/runTestCliChildProcess.js')

        await execWaitForOutput([
            `bun ${childProcessDir.replace(/ /g, '\\ ')}`,
            `--configPath=${cliOptions.configPath}`,
            `--testFlowPath=${cliOptions.testFlowPath}`,
            cliOptions.filter ? `--filter=${cliOptions.filter}` : '',
            startAtTestNb ? `--startAtTestNb=${startAtTestNb}` : ''
        ].join(' '), {
            errorHandle: 'error',
            logOutputStream: true,
            nbSecondsBeforeKillingProcess: -1,
            streamConsoleOutput(outputStr) {
                if (outputStr.includes('%%')) {
                    const lastTestNbStr = outputStr.split('%%')[1]
                    if (lastTestNbStr === 'END') {
                        lastTestNb = 0
                        setTimeout(() => {
                            process.exit(0)
                        }, 2000)
                    } else lastTestNb = /\d+/.test(lastTestNbStr) ? parseInt(lastTestNbStr) : 0
                }
            },
        })

        if (lastTestNb) await onErrorCli(lastTestNb, cliOptions.ci)
    } catch (err) {
        C.error(false, err)
        if (lastTestNb) await onErrorCli(lastTestNb, cliOptions.ci)
    }

}
runTestFlow()

async function onErrorCli(actualTestNb: number, isCi = false) {
    const inquirer = await import('inquirer') // shit modulovitch mess
    if (isCi) throw new Error('TEST FLOW FAILED')
    const choice = await inquirer.prompt({
        type: 'list',
        name: 'action',
        message: 'What to do next ?',
        choices: [`Replay last`, `Continue`, 'Exit'],
    })

    let fromTest = 0

    if (choice.action === 'Exit') return -1
    else if (choice.action === 'Replay last') fromTest = actualTestNb
    else if (choice.action === 'Continue') fromTest = actualTestNb + 1

    runTestFlow(fromTest)
}
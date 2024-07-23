

import path from 'path'
import fs from 'fs/promises'
import argv from 'argv'
import { intro } from './src/rest-test-ascii-display'

import { C, noDuplicateFilter, JSONstringyParse, removeCircularJSONstringify } from 'topkat-utils'

process.env.NODE_ENV = 'test'

let envCache: any[] = []

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
    name: 'startAtTestNb',
    type: 'number'
}]).run()

/** npm run test:api -- --filter=core */
const filter = cliOptions.filter || false

/** NOTE FOR HOT RELOADING IMPLEMENTATION
 * * tryed symplink files and doesn't work
 * * tryed query param on import file (eg: import(myFile + '?v=12345')) didn't work
 * The most promising way seems to be exec and child process to execute tests, but we should
 * separate functions from env in config because config has to be written to a file between
 * tests retrials
 */
export default async function runTestFlow() {
    if (!cliOptions.configPath || !cliOptions.testFlowPath) {
        return C.error(false, 'Please provide --configPath and --testFlowPath arguments')
    }

    const { startAtTestNb: startAtTestNbStr = '0', testFlowPath, configPath } = cliOptions

    const startAtTestNb = /^\d+$/.test(startAtTestNbStr) ? parseInt(startAtTestNbStr) : 0
    const isReload = startAtTestNb > 0

    let restTestState = {}
    if (isReload) {
        // eslint-disable-next-line no-console
        console.log(intro) // do not use C.log
        restTestState = await retrieveEnvFromFile()
    }

    const testFlowPath2 = path.resolve(process.cwd(), testFlowPath)
    const configPath2 = path.resolve(process.cwd(), configPath)

    const restTest = await import('./index.js')
    const scenario = await import(testFlowPath2)
    const restTestConfig = await import(configPath2)

    await restTest.testRunner.runScenario(scenario.default as any, {
        ...restTestConfig.restTestConfig,
        onError: onErrorCli,
        startAtTestNb,
        env: { ...restTestConfig.restTestConfig.env, ...getEnvAtTest(startAtTestNb) },
        afterTest,
        displayIntroTimeout: startAtTestNb > 0 ? 0 : restTestConfig.restTestConfig.displayIntroTimeout,
        filter,
        isReload,
        restTestState,
    })
}
runTestFlow()

async function onErrorCli(actualTestNb: number, restTestState: Record<string, any> = {}) {
    await saveEnvToFile(restTestState)

    // eslint-disable-next-line no-console
    console.log(`%%${actualTestNb}%%`) // send test number so that parent process can interpolate it

    process.exit(0)
}


async function afterTest(actualTestNb: number, env: Record<string, any>) {
    const previousEnv = getEnvAtTest(actualTestNb - 1)
    const allKeys = noDuplicateFilter([...Object.keys(previousEnv), ...Object.keys(env)])
    const actualEnv = JSONstringyParse(env)

    for (const k of allKeys) {
        if (JSON.stringify(actualEnv[k]) === JSON.stringify(previousEnv[k])) delete actualEnv[k]
        else if (typeof actualEnv[k] === 'undefined' && previousEnv[k]) actualEnv[k] = undefined // should override
    }

    envCache[actualTestNb] = actualEnv
}

function getEnvAtTest(testNb: number) {
    return Object.assign({}, ...envCache.slice(0, testNb + 1))
}

async function saveEnvToFile(restTestState: Record<string, any> = {}) {
    await fs.writeFile('./.testenv', removeCircularJSONstringify({
        env: envCache,
        restTestState,
    }))
}

async function retrieveEnvFromFile() {
    const fileAsStr = await fs.readFile('./.testenv', 'utf-8')
    const saveObj = (fileAsStr ? JSON.parse(fileAsStr) : { env: [], restTestState: {} }) as RestTestSave
    envCache = saveObj.env
    return saveObj.restTestState
}

type RestTestSave = { env: any[], restTestState: Record<string, any> }
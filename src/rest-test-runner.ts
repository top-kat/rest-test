
import { TestFlow, Test as TestRaw, TestType, RestMethod, RestTestConfig, TestElement, TestFlowRaw, TestEnvBase } from './rest-test-types'
import { title } from './rest-test-ascii-display'
import axios, { AxiosError } from 'axios'
import { assert, restTest } from './rest-test'

import { isset, C, timeout, urlPathJoin, asArray, round, capitalize1st, isEmptyOrNotSet, getDateAsInt, cliLoadingSpinner } from 'topkat-utils'

type Test = TestRaw<any, any, any>
type TestEnv = ObjectGeneric

type TestArray = ({ testNumber: number, test: TestElement<any, any, any>, testFlow: TestFlowRaw, sectionName: string })[]

export const testRunner = {
    async runScenario(scenario: { [fileName: string]: TestFlow }, config: RestTestConfig) {

        const { startAtTestNb = 0, isReload, restTestState } = config

        if (!isReload) {
            const introTimeout = typeof config.displayIntroTimeout === 'number' ? config.displayIntroTimeout : 800
            await timeout(introTimeout)
        }

        const testFlows: TestFlowRaw[] = []
        for (const [defaultName, testFlowRaw] of Object.entries(scenario)) {
            const testFlow = typeof testFlowRaw == 'function' ? await testFlowRaw() : testFlowRaw
            if (!testFlow) throw new Error(`A test flow of type ${typeof testFlowRaw} is undefined`)
            if (isEmptyOrNotSet(testFlow?.name)) testFlow.name = capitalize1st(defaultName)
            if (!isset(testFlow.priority)) testFlow.priority = 50
            testFlows.push(testFlow)
        }

        // SORT BY PRIORITY
        testFlows.sort((testFlowA, testFlowB) => !isset(testFlowA?.priority, testFlowB?.priority) ? 0 : testFlowA.priority - testFlowB.priority)

        const env = { ...config.env, ...(config.env || { users: {} }) } as TestEnvBase // TODO clean

        const testArray: TestArray = []
        const msgs = []
        const runBeforeFlow: TestElement<any, any, any>[] = []

        let testNumber = 0
        const parseTestFlowsRecursive = (testFlow: TestFlowRaw) => {
            if (testFlow.disable) msgs.push('Test flow disabled ' + testFlow.name)
            else if (testFlow.disableTemporarly && parseInt(getDateAsInt()) <= parseInt(testFlow.disableTemporarly)) {
                msgs.push('Test flow temporarly disabled ' + testFlow.name)
            } else {
                if (isReload && testFlow.beforeReloadAll) {
                    runBeforeFlow.push(...testFlow.beforeReloadAll)
                }
                testFlow.items.forEach(test => {
                    if (Array.isArray(test)) parseTestFlowsRecursive({ items: test })
                    else if ('items' in test) parseTestFlowsRecursive(test)
                    else testArray.push({ testNumber: testNumber++, test, testFlow, sectionName: testFlow.name })
                })
            }
        }

        for (const testFlow of testFlows) parseTestFlowsRecursive(testFlow)

        restTest.startSession(testArray.length, restTestState)


        msgs.forEach(msg => assert(true, msg, { warningMessage: true }))

        testRunner.config = config
        testRunner.testArray = testArray
        testRunner.env = env

        if (config.onBeforeAllTests) {
            try {
                await offlineRetryer(() => config.onBeforeAllTests({ env: testRunner.env, isReload }))
            } catch (err) {
                C.error(false, 'Error in onBeforeAllTests callback')
                C.error(err)
                process.exit(1)
            }
        }

        await testRunner.runTestSuite(startAtTestNb, config, runBeforeFlow)
    },

    async runTestSuite(fromTestNb: number, config: RestTestConfig, runBeforeFlow: TestElement<any, any, any>[]) {
        try {
            if (runBeforeFlow.length) C.info(`BEFORE RELOAD TEST FLOW`)
            try {
                for (const beforeTest of runBeforeFlow) {
                    await testRunner.runTest(beforeTest)
                }
            } catch (err) {
                C.error(false, 'RELOAD TEST FLOW FAILED')
                throw err
            }

            const oneTestIsSoloed = testRunner.testArray.some(t => t.testFlow.solo === true)

            if (config.disableSolo && oneTestIsSoloed) throw 'Solo tests are not allowed'

            let sectionNameCache = ''
            for (const { testNumber, test, testFlow, sectionName } of testRunner.testArray) {
                testRunner.actualTestNb = testNumber

                const { mandatory, solo, name } = testFlow

                const isMandatory = mandatory === true
                const isSolo = oneTestIsSoloed && solo === true
                const filterAccept = !oneTestIsSoloed && (!config.filter || (!name || name.toLowerCase().includes(config.filter.toLowerCase())))

                if (isMandatory || isSolo || filterAccept) {
                    if (testNumber >= fromTestNb) {
                        if (sectionName && sectionName !== sectionNameCache) {
                            sectionNameCache = sectionName
                            restTest.sectionTitle(sectionName)
                        }
                        await testRunner.runTest(test, testFlow)
                    }
                } else {
                    C.info(`Test filtered => ` + testFlow.name)
                }
            }
            restTest.printStats()
        } catch (err) {
            await testRunner.onError(err)
        }
    },

    async runTest(test: TestElement<any, any, any>, testFlow: TestFlowRaw<any, any> = { name: 'default test flow', items: [] }) {

        if (typeof test === 'function') return await test(testRunner.env)

        const defaults = typeof testFlow.defaults === 'function' ? testFlow.defaults(testRunner.env) : testFlow.defaults

        const realTest: Test = { ...(defaults || {}), ...test } as Test

        const {
            d,
            before,
            main,
            svc,
            after,
            errorMessage,
            server,
            serverUrl: serverUrlRaw,
            headers: headersRaw = {},
            method: methosRaw = testRunner.config.mode === 'rest' ? 'GET' : 'POST',
            body: bodyRaw,
            route,
            params,
            warning,
            shallRun,
            info,
            runInParallel,
            auth,
            waitSecBefore,
            waitSecAfter,
            onErrorMsg,
            apiKey
        } = realTest

        let {
            status = 200,
            doc,
            as,
        } = realTest

        if (d && d.length) {
            if (d.length === 2) [as, doc] = d
            else ([status, as, doc] = d)
        }

        const { env, actualTestNb, displayTitleCache, config } = testRunner
        const { onAfterTest, onBeforeTest } = config

        if (waitSecBefore) await waiter(waitSecBefore)

        const serverUrl: string = serverUrlRaw ? await parseTestConfigValue(serverUrlRaw, env) : server ? testRunner.config?.servers[server as string] : testRunner.config?.servers?.default

        const fullRoute: false | string = route ? urlPathJoin(serverUrl, await parseTestConfigValue(route, env)) : false

        const method: RestMethod = await parseTestConfigValue(methosRaw, env)

        const headers = await parseTestConfigValue(headersRaw, env)

        const body = params ? { params: await parseTestConfigValue(params, env) } : bodyRaw ? await parseTestConfigValue(bodyRaw, env) : {}

        if (auth) headers.Authorization = await parseTestConfigValue(auth, env)
        let stringApiKey: string
        let realAs: string | Record<string, any>
        if (apiKey) {
            const realApiKey = await parseTestConfigValue(apiKey, env) as string
            stringApiKey = testRunner.config.apiKeys[realApiKey]?.token ?? realApiKey
            headers.apiKey = stringApiKey
        }
        if (as && as !== 'public' && as !== 'system') {
            if (!env.users) env.users = {}
            realAs = await parseTestConfigValue(as, env)
        }

        try {
            await onBeforeTest({ as: realAs, env, apiKey: stringApiKey, headers: headers || {} })
        } catch (err) {
            C.error(false, 'Error in before test callback')
            throw err
        }

        // DISPLAY TITLE
        if (testFlow?.name && displayTitleCache !== testFlow.name) {
            testRunner.displayTitleCache = testFlow.name
            title(testFlow.name)
        }

        const testDescription = `${actualTestNb + 1}) ${doc || `${asArray(status).join(' | ') + ' '}${testRunner.config?.mode === 'rest' || method.toLowerCase() !== 'post' ? method + ' ' : ''}${fullRoute}`}`

        restTest.newTest(actualTestNb, testDescription)

        if (info) C.info(info)
        if (warning) C.warning(false, warning)
        if (typeof before === 'function') await before(env)

        const errExtrInfos = { method, fullRoute, body }

        const runTestAsync = async (isAsync = false) => {
            let response, axiosErrMsg, errMsg, respStatus
            try {
                const timeBefore = Date.now()
                const isRoute = fullRoute !== false

                try {
                    if (svc) {
                        response = await svc(env)
                        respStatus = 200
                    } else if (main) {
                        response = await main(env)
                        respStatus = 200
                    } else if (isRoute) {
                        const { data, status } = await axios({
                            method,
                            headers,
                            url: fullRoute,
                            data: body,
                            withCredentials: true,
                        })
                        response = data
                        respStatus = status
                    }
                } catch (err) {
                    if (err.name === 'ConnectionRefused') throw err
                    if (isRoute) {
                        const axiosErr: AxiosError = err
                        axiosErrMsg = axiosErr.toString()
                        errMsg = response?.data?.msg || axiosErr.response?.statusText
                        response = axiosErr?.response?.data
                        respStatus = axiosErr?.response?.status || 500
                    } else {
                        response = err
                        respStatus = err?.code
                        errMsg = (err?.msg || err?.message || err).toString()
                    }
                }
                const perfTime = Date.now() - timeBefore

                if (isRoute) restTest.registerPerfForRoute(fullRoute, perfTime)

                if (perfTime > 400) C.warning(false, `Perf: ${perfTime}ms <= LOW PERFS`)
                else C.info(`Perf: ${perfTime}ms`)

                if (status) {
                    assert(
                        respStatus,
                        'Response status',
                        { in: asArray(await parseTestConfigValue(status, env)) },
                        { bypassIssetCheck: true }
                    )
                }
                if (errorMessage) assert(
                    errMsg,
                    'Error message',
                    await parseTestConfigValue(errorMessage, env),
                    { bypassIssetCheck: true }
                )

                if (after) await after(env, response)

                if (testRunner.config.afterTest) await testRunner.config.afterTest(actualTestNb, env)

                await onAfterTest({ as: realAs, env, apiKey: stringApiKey, headers: headers || {} })

                return 'ok' as const

            } catch (err) {
                if (onErrorMsg) {
                    if (typeof onErrorMsg === 'string') C.warning(false, onErrorMsg)
                    else await onErrorMsg()
                }
                if (err.extraInfos || err.options) {
                    const extraInfs = (err.extraInfos || err.options)
                    extraInfs.apiResponse = response
                    extraInfs.axiosErrMsg = axiosErrMsg
                    Object.assign(extraInfs, errExtrInfos)
                }
                if (isAsync) await testRunner.onError(err)
                else throw err
            }
        }

        if (waitSecAfter) await waiter(waitSecAfter)

        if (await parseTestConfigValue(shallRun, env) !== false) {
            if (runInParallel) runTestAsync(true)
            else {
                await offlineRetryer(() => runTestAsync())
            }
        }
    },

    async onError(err) {
        if (err.log) err.log()
        else C.error(err)
        await testRunner.config.onError(testRunner.actualTestNb, restTest.getSave())
    },

    actualTestNb: 0,
    testArray: [] as TestArray,
    env: { users: {} } as TestEnvBase,
    config: {} as RestTestConfig,
    isStopped: false,
    displayTitleCache: '',
    reset() {
        testRunner.testArray = []
        testRunner.env = { users: {} }
        testRunner.config = { onError: () => 0 } as any
        testRunner.isStopped = false
        testRunner.displayTitleCache = ''
        testRunner.actualTestNb = 0
    }
}

async function parseTestConfigValue<T>(value: TestType<TestEnv, T>, env: TestEnv): Promise<T> {
    return typeof value === 'function' ? await (value as any)(env) : value
}

async function waiter(nbSec: number) {
    C.info(`Starting wait counter for ${nbSec} seconds`)
    const spinner = new cliLoadingSpinner()
    spinner.start('' + nbSec)

    while (nbSec > 0) {
        spinner.progressMessage = '' + nbSec--
        await timeout(nbSec < 1 ? nbSec : 1000)
    }

    spinner.end()
}


async function offlineRetryer(callback) {
    const i = 1
    const maxN = 120
    let hasConnexionErr = true
    while (hasConnexionErr) {
        // /!\ Duplicate code, see above TODO
        if (i > maxN) {
            C.error(false, `CONNEXION REFUSED: tryed ${maxN} times. Aborting...`)
            throw 'backend not connected'
        }
        try {
            await callback()
            hasConnexionErr = false
        } catch (err) {
            if (err.name === 'ConnectionRefused' || err?.msg?.includes('onBeforeAllTests') || err?.message?.includes('onBeforeAllTests') || err?.toString().includes('onBeforeAllTests')) {
                const time = 2000
                C.warning(false, `CONNEXION REFUSED: waiting ${round(time / 1000, 2)} seconds before retry`)
                await timeout(time)
            } else throw err
        }
    }
}
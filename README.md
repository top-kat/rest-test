

```
=====================================================
    ____  _________________   _______________________
   / __ \/ ____/ ___/_  __/  /_  __/ ____/ ___/_  __/
  / /_/ / __/  \__ \ / /      / / / __/  \__ \ / /   
 / _, _/ /___ ___/ // /      / / / /___ ___/ // /    
/_/ |_/_____//____//_/      /_/ /_____//____//_/     

TEST() && REST() || DIE()                      V1.0.0                       

=====================================================

```



Rest test is an automated tool to help test an API in the cli. It as been made as an alternative to postman to simplify git workflow and assertions/readability.

This package is used in production code but ⚠️ **open sourcing is in progress** ⚠️. Please feel free to get in touch if you are interrested (via creating an issue for example)

# start

Here is the start script in package.json

```
rest-test --configPath=./path/to/my/config --testFlowPath=./path/to/my/test/flow
```


# Writing a test flow

``` typescript
import { TestFlow } from './Path/to/my/config'
import { TestItem, assert } from 'rest-test'



const testFlow = {
    name: 'login test flow',
    solo: true, // when working with multiple test flows, you can run only this one by using a filter in CLI params or putting solo to true
    priority: 10, // when working with multiple test flows, you can set a priority to sort test, the lower, the prior
    items: [
        // EXPLICIT way
        {
            description: `As user A I can't get userB infos`,
            route: 'my/route', // server url will be appended by default
            apiKey: 'userA', // this is typed and will be passed for the config to retrieve apiKey
            // Or you can use
            as: 'userA',
            status: 403,
            after(env, data) {
                // use snippets to generate assertions
                // when asserting, the assertion message will be automatically computed
                assert(data.errorMessage, 'data.errorMessage', { type: 'string' }) // type
                assert(data.errorMessage, 'data.errorMessage', 'no permission') // equality
            }
        },
        // SHORT WAY
        {
            d: [403, 'userA', `I can't get userB infos`], // read it like 403, as userA...
            route: 'my/route',
            after(env, data) {
                // ...
            }
        },
    ]
} satisfies TestFlow<TestEnv>

export default testFlow

```

# Config

Here is an example config

```typescript


import { RestTestConfig, TestFlow as TestFlowRaw, TestItem as TestItemRaw, assert } from 'rest-test'
import { assert } from 'rest-test'


export const restTestEnv = {
    routes: allRoutes, // here all routes are put in env so that we have autocomplete on possible routes
}

/** Allow shorcut when testing on multiples servers */
export const servers = {
    default: generalConfig.serverLiveUrl,
}


type ConnexionInfos = { email: string, password: string }
type TestUserNames = keyof typeof testUsers

export const restTestConfig: RestTestConfig<'userA' | 'userB', { baseEnvType: true }, TestUserNames, ConnexionInfos> = {
    servers: {
        default: generalConfig.serverLiveUrl,
    },
    disableSolo: generalConfig.env === 'ci', //
    apiKeys: generalConfig.apiKeys as any,
    env: restTestEnv,
    //----------------------------------------
    // BEFORE ALL TESTS
    //----------------------------------------
    async onBeforeAllTests({ 
        env,
        isReload // was it the first run or is it just a hot reload OR retry
    }) {
        // INIT BACKEND SDK
        $.init('http://localhost:9086')

        if (!isReload) {
            C.info('CLEARING THE DATABASE AND SEEDING')
        }
    },
    //----------------------------------------
    // BEFORE / AFTER EACH TEST
    //----------------------------------------
    async onBeforeTest({ env, as, apiKey, headers }) {
        // here you have all the test config, so you can modify headers the way you want for example
        if (apiKey || as) {
            // login with apiKey
            headers.Authorization = apiKeys[apiKey || as]
        }
    },
    onAfterTest() {
        $.setHeaders({ Authorization: null }, true)
        $.setAuthorization(null)
    },
}

// exports so you can use them with the right type
export type TestFlow<EnvFromUser> = TestFlowRaw<TestUserNames, ConnexionInfos, typeof restTestConfig & { env: typeof restTestConfig['env'] & typeof restTestEnv & EnvFromUser }>

export type TestItem<EnvFromUser> = TestItemRaw<TestUserNames, ConnexionInfos, typeof restTestConfig & { env: typeof restTestConfig['env'] & typeof restTestEnv & EnvFromUser }>
```
# Changelog

All notable changes to this project will be documented in this file.

## [0.13.0](https://github.com/inference-gateway/typescript-adk/compare/v0.12.0...v0.13.0) (2026-07-19)

### ✨ Features

* add llamacpp provider support ([#179](https://github.com/inference-gateway/typescript-adk/issues/179)) ([d9b182a](https://github.com/inference-gateway/typescript-adk/commit/d9b182ab4d66da156d9786bf98db03932fe2b951))
* **telemetry:** support Prometheus pull metrics exporter via OTEL_METRICS_EXPORTER ([#175](https://github.com/inference-gateway/typescript-adk/issues/175)) ([d22e026](https://github.com/inference-gateway/typescript-adk/commit/d22e026fb2738865a60d23ce058bd7926b5646ab)), references [inference-gateway/docs#409](https://github.com/inference-gateway/docs/issues/409)

### 👷 CI

* **claude:** centralize claude.yml via reusable workflow ([#171](https://github.com/inference-gateway/typescript-adk/issues/171)) ([b338842](https://github.com/inference-gateway/typescript-adk/commit/b338842008564dfd5a85b4405194207c7e892246))
* **infer:** centralize infer.yml via reusable workflow ([#168](https://github.com/inference-gateway/typescript-adk/issues/168)) ([f1b39d5](https://github.com/inference-gateway/typescript-adk/commit/f1b39d5be25f1a91cc2bc28a24977155e349c41d))
* **infer:** centralize infer.yml via reusable workflow ([#169](https://github.com/inference-gateway/typescript-adk/issues/169)) ([b8fc5f1](https://github.com/inference-gateway/typescript-adk/commit/b8fc5f1441d8df1ee9e2f6bb11446b8f61d06c4d))
* **release:** update semantic release and plugins to latest versions with local installation ([9943e44](https://github.com/inference-gateway/typescript-adk/commit/9943e4487dc0c29cb123e0a40bd03aee78016dd4))
* restrict default workflow token permissions to contents: read ([#167](https://github.com/inference-gateway/typescript-adk/issues/167)) ([42381b2](https://github.com/inference-gateway/typescript-adk/commit/42381b2ef4ddb7a2a2ba596848923028c542d7d7))

### 🔧 Miscellaneous

* **deps:** bump claude-code 2.1.197 -> 2.1.201 ([#161](https://github.com/inference-gateway/typescript-adk/issues/161)) ([e227f94](https://github.com/inference-gateway/typescript-adk/commit/e227f9416fe6af9d9c2ce091ba2fc7d755c567b9))
* **deps:** bump claude-code-action v1.0.165 -> v1.0.169 ([#170](https://github.com/inference-gateway/typescript-adk/issues/170)) ([d86f421](https://github.com/inference-gateway/typescript-adk/commit/d86f421dc77619d3768febc5adbb0b7509dd509e))
* **deps:** bump infer CLI v0.130.1 -> v0.133.0, infer-action v0.23.1 -> v0.26.0 ([#162](https://github.com/inference-gateway/typescript-adk/issues/162)) ([0fe729b](https://github.com/inference-gateway/typescript-adk/commit/0fe729b25075bb91ab23f2d9557c54d1fda3993d))
* **deps:** bump infer CLI v0.133.0 -> v0.133.1, infer-action v0.26.0 -> v0.27.1 ([#164](https://github.com/inference-gateway/typescript-adk/issues/164)) ([ddebc37](https://github.com/inference-gateway/typescript-adk/commit/ddebc375fd6cfcdd0d66219f2967d5e46d783727))
* **deps:** bump infer CLI v0.133.1 -> v0.137.0, infer-action v0.27.1 -> v0.29.0 ([#165](https://github.com/inference-gateway/typescript-adk/issues/165)) ([a6f3e2e](https://github.com/inference-gateway/typescript-adk/commit/a6f3e2e6bdcc62d2161fdd7e62b258e2d2110422))
* **deps:** bump infer CLI v0.137.0 -> v0.138.0, infer-action v0.29.0 -> v0.30.1 ([#166](https://github.com/inference-gateway/typescript-adk/issues/166)) ([28886db](https://github.com/inference-gateway/typescript-adk/commit/28886db8aeee0fad142996c97d5efa0fb9df6b0c))
* **deps:** bump infer CLI v0.138.0 -> v0.141.0 ([#172](https://github.com/inference-gateway/typescript-adk/issues/172)) ([e590942](https://github.com/inference-gateway/typescript-adk/commit/e590942e99520fc475947e6f3392fa06989fdfee))
* **deps:** bump infer CLI v0.141.0 -> v0.147.1 ([#176](https://github.com/inference-gateway/typescript-adk/issues/176)) ([43804e8](https://github.com/inference-gateway/typescript-adk/commit/43804e8a12bf355895ff871ebca35723a9b4723b))
* **deps:** bump the npm group with 10 updates (revert typescript 7.0.2) ([#173](https://github.com/inference-gateway/typescript-adk/issues/173)) ([12a47d2](https://github.com/inference-gateway/typescript-adk/commit/12a47d25070854df198102289c1671f4352d93ef))
* **deps:** bump the npm group with 11 updates ([#160](https://github.com/inference-gateway/typescript-adk/issues/160)) ([b929e09](https://github.com/inference-gateway/typescript-adk/commit/b929e09a72c29eb1950403a2cf1e663efcbfb574))
* **release:** update Git author and committer names to use app slug ([390138e](https://github.com/inference-gateway/typescript-adk/commit/390138e288f84c3e1a21c6a7d41661e9c800924b))
* **release:** update GitHub App credentials to use RELEASER_APP_ID and RELEASER_APP_PRIVATE_KEY ([1877b06](https://github.com/inference-gateway/typescript-adk/commit/1877b068d1f7f90f98925f7a147befa777138c08))

## [0.12.0](https://github.com/inference-gateway/typescript-adk/compare/v0.11.0...v0.12.0) (2026-07-06)

## [0.11.0](https://github.com/inference-gateway/typescript-adk/compare/v0.10.0...v0.11.0) (2026-05-30)

### ✨ Features

* add Prometheus metrics endpoint ([#108](https://github.com/inference-gateway/typescript-adk/issues/108)) ([b67a3a6](https://github.com/inference-gateway/typescript-adk/commit/b67a3a630cc08c1e9b4fa19653f8615bbb1d8293))
* add protocol-methods walkthrough example ([#112](https://github.com/inference-gateway/typescript-adk/issues/112)) ([362411f](https://github.com/inference-gateway/typescript-adk/commit/362411fe09a0bb9efc400024f07970c3e8a1e408))
* add static agent card example ([#111](https://github.com/inference-gateway/typescript-adk/issues/111)) ([01dbc3c](https://github.com/inference-gateway/typescript-adk/commit/01dbc3cb722985b9907b5275a3c094d795635385)), closes [#53](https://github.com/inference-gateway/typescript-adk/issues/53)
* add task retention policies and cleanup ([#110](https://github.com/inference-gateway/typescript-adk/issues/110)) ([87560a2](https://github.com/inference-gateway/typescript-adk/commit/87560a27b6d7a405641d3c4a087781fdb9929029))
* add TLS server support and client config ([#109](https://github.com/inference-gateway/typescript-adk/issues/109)) ([d5eed96](https://github.com/inference-gateway/typescript-adk/commit/d5eed96233b81d4860da308fdfb92292a13e92d6))
* add usage metadata tracking and example ([#107](https://github.com/inference-gateway/typescript-adk/issues/107)) ([91ba0e0](https://github.com/inference-gateway/typescript-adk/commit/91ba0e04fa6111a274dc2a7587ee1bd17760d23c))
* **telemetry:** add OpenTelemetry observability integration ([#106](https://github.com/inference-gateway/typescript-adk/issues/106)) ([aa4142c](https://github.com/inference-gateway/typescript-adk/commit/aa4142c8f3fc86ac58ca4fa85d772db44fe745b3)), closes [#48](https://github.com/inference-gateway/typescript-adk/issues/48)

### 👷 CI

* **deps:** bump infer-action version 0.7.0 -> 0.7.1 ([fbfe663](https://github.com/inference-gateway/typescript-adk/commit/fbfe66396edecc2b1f32c5d5ec0ff9edabdf5c8a))
* **deps:** bump infer-action version 0.7.1 -> 0.8.0 ([0769d4b](https://github.com/inference-gateway/typescript-adk/commit/0769d4b6f87463994198b676d9b9815e8572d741))
* **deps:** bump infer-action version v0.6.0.-rc.1 -> v0.6.0.-rc.2 ([ff8a473](https://github.com/inference-gateway/typescript-adk/commit/ff8a473401a14c71bf36cfff86d66bc1dbecef9f))
* **infer:** use the new bash-whitelisted-commands-append to just append a few more commands to the list ([1a830ac](https://github.com/inference-gateway/typescript-adk/commit/1a830acb5823c95a7b051c380c7e0db644535fe7))

### 🔧 Miscellaneous

* **deps:** bump infer-action to version 0.6.0 ([fdbbd61](https://github.com/inference-gateway/typescript-adk/commit/fdbbd61f83012fbeca0f69da914716b6940d1e6f))
* **deps:** bump infer-action version 0.6.0 -> 0.7.0 ([b18fe03](https://github.com/inference-gateway/typescript-adk/commit/b18fe0337d0863089b108aa12b09cb5e1a46989d))
* **deps:** bump infer-action version v0.6.0-rc.2 -> v0.6.0-rc.3 ([9c94be0](https://github.com/inference-gateway/typescript-adk/commit/9c94be077e16461b57bb403a1f61064e5fa35a32))
* **deps:** bump inference-gateway/infer-action version 0.6.0 -> 0.6.1 ([1e20fef](https://github.com/inference-gateway/typescript-adk/commit/1e20fefeadf3fdb07793efdd83f43ab8963a9d04))
* **deps:** bump inference-gateway/infer-action version 0.6.1 -> 0.6.2 ([775c810](https://github.com/inference-gateway/typescript-adk/commit/775c810cfb19d6a1a0c96d48ab51bbaadd6d7435))
* **infer:** add git to bash whitelist commands ([0305225](https://github.com/inference-gateway/typescript-adk/commit/0305225b284d75f8c58202c2f6f6c5cf49f02f76))
* **infer:** add mkdir to whitelisted commands ([919c4f3](https://github.com/inference-gateway/typescript-adk/commit/919c4f307fe5eff26dd8675e6d35dcd9db71ea61))
* **infer:** broaden bash whitelist for read-only discovery commands ([#105](https://github.com/inference-gateway/typescript-adk/issues/105)) ([a9588ad](https://github.com/inference-gateway/typescript-adk/commit/a9588ad0fa01db3a6c7447708393b80cb02ee284)), closes [#48](https://github.com/inference-gateway/typescript-adk/issues/48)

## [0.10.0](https://github.com/inference-gateway/typescript-adk/compare/v0.9.0...v0.10.0) (2026-05-28)

### ✨ Features

* add RedisTaskStorage backend for horizontal scaling ([#95](https://github.com/inference-gateway/typescript-adk/issues/95)) ([bff62bc](https://github.com/inference-gateway/typescript-adk/commit/bff62bc8ac82d9017e0b76ce5d0e448943931781)), closes [#40](https://github.com/inference-gateway/typescript-adk/issues/40)
* **artifacts:** add ArtifactService abstraction ([#97](https://github.com/inference-gateway/typescript-adk/issues/97)) ([a9afeca](https://github.com/inference-gateway/typescript-adk/commit/a9afecad728d877d94b1f6e49c008a70da7ad240)), closes [#42](https://github.com/inference-gateway/typescript-adk/issues/42)
* **artifacts:** add filesystem storage and HTTP download route ([#98](https://github.com/inference-gateway/typescript-adk/issues/98)) ([35b369f](https://github.com/inference-gateway/typescript-adk/commit/35b369f14763671096c2ae9c24358bf48cd38ea6))
* **artifacts:** add S3/MinIO storage backend ([#99](https://github.com/inference-gateway/typescript-adk/issues/99)) ([79cb5b5](https://github.com/inference-gateway/typescript-adk/commit/79cb5b59d301183dcf7620242c76e27b634a5e73))
* **examples:** add queue-storage in-memory and redis variants ([#96](https://github.com/inference-gateway/typescript-adk/issues/96)) ([ec6d0d1](https://github.com/inference-gateway/typescript-adk/commit/ec6d0d16e38f5cfe4af18a7c6a3efff0f93ea893)), closes [#41](https://github.com/inference-gateway/typescript-adk/issues/41)
* implement agent/getAuthenticatedExtendedCard JSON-RPC method ([#91](https://github.com/inference-gateway/typescript-adk/issues/91)) ([d5e1087](https://github.com/inference-gateway/typescript-adk/commit/d5e1087cddc655309264deb5165cc1580330ae6d)), closes [#36](https://github.com/inference-gateway/typescript-adk/issues/36)
* implement HTTP push notification delivery ([#93](https://github.com/inference-gateway/typescript-adk/issues/93)) ([bd99530](https://github.com/inference-gateway/typescript-adk/commit/bd99530de73f1740cb306708a0493c249bda7d62)), closes [#38](https://github.com/inference-gateway/typescript-adk/issues/38)
* implement push notification config CRUD methods ([#92](https://github.com/inference-gateway/typescript-adk/issues/92)) ([3fdd35b](https://github.com/inference-gateway/typescript-adk/commit/3fdd35b13aad08c7b0a9a38d42cc563579eaefbc)), closes [#37](https://github.com/inference-gateway/typescript-adk/issues/37)
* **logging:** add structured logging via pino ([#104](https://github.com/inference-gateway/typescript-adk/issues/104)) ([d7f419f](https://github.com/inference-gateway/typescript-adk/commit/d7f419f5eb362b154cf1a4793a10b8fe3ffec341))
* **server:** autonomous create_artifact reserved tool ([#100](https://github.com/inference-gateway/typescript-adk/issues/100)) ([c13e7b1](https://github.com/inference-gateway/typescript-adk/commit/c13e7b1ada6cffdb7830a6e363561250a49f64b2))
* **storage:** add TaskStorage conformance suite and `./testing` subpath ([#94](https://github.com/inference-gateway/typescript-adk/issues/94)) ([7146f4b](https://github.com/inference-gateway/typescript-adk/commit/7146f4b4045b62e61051f3bfba4c9325d999768e)), closes [#39](https://github.com/inference-gateway/typescript-adk/issues/39)

### 🐛 Bug Fixes

* **infer:** remove concurrency cancel in progress protection ([8f1b918](https://github.com/inference-gateway/typescript-adk/commit/8f1b918d8ed67de645f37bbcd91cf1075ec3c91c))

### 👷 CI

* **claude:** add instructions to create a pr ([9ab4465](https://github.com/inference-gateway/typescript-adk/commit/9ab4465d812487c85439578fa1b71b9d96a4b1a9))
* **claude:** download all maintainer skill assets ([6f8b69b](https://github.com/inference-gateway/typescript-adk/commit/6f8b69b163a4ad12b271daa156efa4f6783e2521))
* **claude:** improve system prompt ([ecd8728](https://github.com/inference-gateway/typescript-adk/commit/ecd8728e38567330ac8db8a2369eac092017c912))
* **claude:** try a different approach ([696a150](https://github.com/inference-gateway/typescript-adk/commit/696a150a91f7a970c97857e9b7edb89ce26a373e))
* **claude:** try a different approach ([8a8c87d](https://github.com/inference-gateway/typescript-adk/commit/8a8c87d617611183a1ca105ecc33ad0efbdfafc8))
* **deps:** bump infer-action version v0.5.0 -> v0.5.1 ([757cf56](https://github.com/inference-gateway/typescript-adk/commit/757cf56fb12f5c47e6b538d4cc2e283b51df76db))
* **infer:** add infer action ([51f9a62](https://github.com/inference-gateway/typescript-adk/commit/51f9a622f312f7641568823284da5d05f6f18b10))
* **infer:** test mock agent behavior ([d965bfa](https://github.com/inference-gateway/typescript-adk/commit/d965bfab401069d945487feee7878d1c7655e75b))

### 📚 Documentation

* **examples:** add artifact examples for filesystem, minio, autonomous tool, and default handlers ([#101](https://github.com/inference-gateway/typescript-adk/issues/101)) ([a23dba6](https://github.com/inference-gateway/typescript-adk/commit/a23dba6aab853b40df6edd147a54c8bc456f68c0))

### 🔧 Miscellaneous

* add whitelisted commands ([019abb1](https://github.com/inference-gateway/typescript-adk/commit/019abb1d3db8ef0732759e871cb161e82aa1d963))

## [0.9.0](https://github.com/inference-gateway/typescript-adk/compare/v0.8.0...v0.9.0) (2026-05-27)

### ✨ Features

* **callbacks:** wire lifecycle hooks into default task handlers ([#87](https://github.com/inference-gateway/typescript-adk/issues/87)) ([f33ae90](https://github.com/inference-gateway/typescript-adk/commit/f33ae902e32b7130de3070c12aa2effa4b00c084)), closes [#32](https://github.com/inference-gateway/typescript-adk/issues/32)
* **examples:** add ai-powered LLM agent example ([#84](https://github.com/inference-gateway/typescript-adk/issues/84)) ([6334633](https://github.com/inference-gateway/typescript-adk/commit/63346333673cea26db672d0e9ad1ab6561374176))
* **examples:** add ai-powered streaming agent example ([#85](https://github.com/inference-gateway/typescript-adk/issues/85)) ([7c0c08c](https://github.com/inference-gateway/typescript-adk/commit/7c0c08c7fbb0b12f16b9212e07732f5f61af0a9d)), closes [#30](https://github.com/inference-gateway/typescript-adk/issues/30)
* **examples:** add callbacks example with guardrail, cache, and audit hooks ([#88](https://github.com/inference-gateway/typescript-adk/issues/88)) ([edbc76d](https://github.com/inference-gateway/typescript-adk/commit/edbc76dbbbeeec371e95c4cf82a14cab06d14c0a)), closes [#33](https://github.com/inference-gateway/typescript-adk/issues/33)
* **examples:** add default-handlers example using A2AServerBuilder.withDefaultTaskHandlers ([#89](https://github.com/inference-gateway/typescript-adk/issues/89)) ([ddb2804](https://github.com/inference-gateway/typescript-adk/commit/ddb28045932fbcca8c2a1d1322b579f67e3a1bcb)), closes [#34](https://github.com/inference-gateway/typescript-adk/issues/34)
* implement OIDC/OAuth2 authentication middleware ([#90](https://github.com/inference-gateway/typescript-adk/issues/90)) ([43d43ba](https://github.com/inference-gateway/typescript-adk/commit/43d43baaa71dc2d27044f124852585d31985a8e5)), closes [#35](https://github.com/inference-gateway/typescript-adk/issues/35)
* **toolbox:** custom Tool + ToolBox API with schema validation and parallel dispatch ([#86](https://github.com/inference-gateway/typescript-adk/issues/86)) ([0e83473](https://github.com/inference-gateway/typescript-adk/commit/0e83473f81ad2be63522c556c15d654015c1e280))

### 🔧 Miscellaneous

* remove package-lock.json ([82c1c9d](https://github.com/inference-gateway/typescript-adk/commit/82c1c9d0784c1fe1379821a165ee3c3f0362a4dd))
* use normal dashes instead of em dashes ([3320097](https://github.com/inference-gateway/typescript-adk/commit/3320097bcf5ab25623709453eee2eae59346ce47))
* use normal dashes instead of em dashes ([37d8efe](https://github.com/inference-gateway/typescript-adk/commit/37d8efe6caa03c874058fc87f7a7eba382bd3e4b))

## [0.8.0](https://github.com/inference-gateway/typescript-adk/compare/v0.7.0...v0.8.0) (2026-05-27)

### ✨ Features

* **agent:** add AgentBuilder for LLM-powered handlers ([#83](https://github.com/inference-gateway/typescript-adk/issues/83)) ([12ea3b3](https://github.com/inference-gateway/typescript-adk/commit/12ea3b311c94448bcf1d14d3d021a9253f5c02ef)), closes [#28](https://github.com/inference-gateway/typescript-adk/issues/28)
* **examples:** add input-required pause/resume example ([#81](https://github.com/inference-gateway/typescript-adk/issues/81)) ([035bd7f](https://github.com/inference-gateway/typescript-adk/commit/035bd7f6bff535267f209530eb5687dcf79aaa58)), closes [#26](https://github.com/inference-gateway/typescript-adk/issues/26)
* **llm:** add OpenAI-compatible LLM client backed by Inference Gateway SDK ([#82](https://github.com/inference-gateway/typescript-adk/issues/82)) ([f59a5ed](https://github.com/inference-gateway/typescript-adk/commit/f59a5ede0a99cd3e7356e907a844e4a74635f306)), closes [#27](https://github.com/inference-gateway/typescript-adk/issues/27)
* **server:** implement DefaultBackgroundTaskHandler ([#74](https://github.com/inference-gateway/typescript-adk/issues/74)) ([b6e9afc](https://github.com/inference-gateway/typescript-adk/commit/b6e9afc1e926be5e8cbe0acd44e012585a2bf75a)), closes [27/#31](https://github.com/27/typescript-adk/issues/31) [#19](https://github.com/inference-gateway/typescript-adk/issues/19)
* **server:** implement DefaultStreamingTaskHandler ([#75](https://github.com/inference-gateway/typescript-adk/issues/75)) ([9ae65c7](https://github.com/inference-gateway/typescript-adk/commit/9ae65c793c6c8f11a1748e140049c377541b8e59)), closes [#20](https://github.com/inference-gateway/typescript-adk/issues/20)
* **server:** implement input-required reserved tool and pause/resume flow ([#80](https://github.com/inference-gateway/typescript-adk/issues/80)) ([3f47a89](https://github.com/inference-gateway/typescript-adk/commit/3f47a89dda9b5ddacf9b3021a2769c0c20627186)), closes [#25](https://github.com/inference-gateway/typescript-adk/issues/25)
* **server:** implement tasks/cancel JSON-RPC method ([#78](https://github.com/inference-gateway/typescript-adk/issues/78)) ([f4a4d32](https://github.com/inference-gateway/typescript-adk/commit/f4a4d322036937dafb92153a3b8599d2bce8b16d))
* **server:** implement tasks/list JSON-RPC method with cursor pagination ([#77](https://github.com/inference-gateway/typescript-adk/issues/77)) ([604e3b5](https://github.com/inference-gateway/typescript-adk/commit/604e3b530434b4239f6f32ecf7626e2bacf3b889)), closes [#22](https://github.com/inference-gateway/typescript-adk/issues/22)
* **server:** implement tasks/resubscribe JSON-RPC method ([#79](https://github.com/inference-gateway/typescript-adk/issues/79)) ([c4ee6a2](https://github.com/inference-gateway/typescript-adk/commit/c4ee6a2d86cccde720d40b108ba749afb98746d6)), closes [#24](https://github.com/inference-gateway/typescript-adk/issues/24)
* **server:** support custom task handlers via TaskHandler / StreamableTaskHandler interfaces ([#76](https://github.com/inference-gateway/typescript-adk/issues/76)) ([9a09599](https://github.com/inference-gateway/typescript-adk/commit/9a09599c7bc4e9b097e3da5847b148e498f5a0d1)), closes [#21](https://github.com/inference-gateway/typescript-adk/issues/21)

## [0.7.0](https://github.com/inference-gateway/typescript-adk/compare/v0.6.0...v0.7.0) (2026-05-27)

### ✨ Features

* **examples:** add minimal A2A server + client example without LLM ([#69](https://github.com/inference-gateway/typescript-adk/issues/69)) ([c35c557](https://github.com/inference-gateway/typescript-adk/commit/c35c5574406d6b19ee63d24bf91a7cc0fa6969e8)), closes [#14](https://github.com/inference-gateway/typescript-adk/issues/14)
* **examples:** add streaming server + client example ([#72](https://github.com/inference-gateway/typescript-adk/issues/72)) ([4d3a463](https://github.com/inference-gateway/typescript-adk/commit/4d3a4637aa536bbaf1a478310b977ad0ffb69b57)), closes [#17](https://github.com/inference-gateway/typescript-adk/issues/17)
* **server:** add A2AServerBuilder fluent API ([#73](https://github.com/inference-gateway/typescript-adk/issues/73)) ([92d5cc6](https://github.com/inference-gateway/typescript-adk/commit/92d5cc687a79d2a1a11a1fc80ce3ee59c21bf9f7)), closes [#18](https://github.com/inference-gateway/typescript-adk/issues/18)
* **server:** implement message/stream JSON-RPC method with SSE transport ([#71](https://github.com/inference-gateway/typescript-adk/issues/71)) ([bc084ab](https://github.com/inference-gateway/typescript-adk/commit/bc084ab9b3d8e011a72c1d102781518303989454)), closes [#16](https://github.com/inference-gateway/typescript-adk/issues/16)
* **server:** implement SSE streaming transport with CloudEvents v1.0 envelope ([#70](https://github.com/inference-gateway/typescript-adk/issues/70)) ([52ddd95](https://github.com/inference-gateway/typescript-adk/commit/52ddd95366796c432d53c6a0da9ea53c9c0d372c)), closes [#15](https://github.com/inference-gateway/typescript-adk/issues/15)

### 📚 Documentation

* improve the readme ([6f0077a](https://github.com/inference-gateway/typescript-adk/commit/6f0077ae47719ad91de078bd99117c943e6a7c00))

## [0.6.0](https://github.com/inference-gateway/typescript-adk/compare/v0.5.0...v0.6.0) (2026-05-26)

### ✨ Features

* add in-memory task storage backend ([#65](https://github.com/inference-gateway/typescript-adk/issues/65)) ([68d23a7](https://github.com/inference-gateway/typescript-adk/commit/68d23a7829170500034db85b36ed56ba6db70f9d)), closes [#10](https://github.com/inference-gateway/typescript-adk/issues/10)
* **client:** implement A2A client SDK ([#68](https://github.com/inference-gateway/typescript-adk/issues/68)) ([b1dd331](https://github.com/inference-gateway/typescript-adk/commit/b1dd3313064da1c3a6167d039e8d61b9663f08d9))
* implement message/send JSON-RPC method ([#66](https://github.com/inference-gateway/typescript-adk/issues/66)) ([885dd96](https://github.com/inference-gateway/typescript-adk/commit/885dd966d87b4fac847752e6fd945a2a5fca355b)), closes [#11](https://github.com/inference-gateway/typescript-adk/issues/11)
* implement task lifecycle and state machine ([#64](https://github.com/inference-gateway/typescript-adk/issues/64)) ([7fea31d](https://github.com/inference-gateway/typescript-adk/commit/7fea31d767cf56563fec9b742186afb4c1132990)), closes [#9](https://github.com/inference-gateway/typescript-adk/issues/9)
* implement tasks/get JSON-RPC method ([#67](https://github.com/inference-gateway/typescript-adk/issues/67)) ([113e939](https://github.com/inference-gateway/typescript-adk/commit/113e939acb0e8ded9cb24883b539c84e2b2028c5)), closes [#12](https://github.com/inference-gateway/typescript-adk/issues/12)

## [0.5.0](https://github.com/inference-gateway/typescript-adk/compare/v0.4.0...v0.5.0) (2026-05-26)

### ✨ Features

* **server:** implement A2A JSON-RPC server core ([#63](https://github.com/inference-gateway/typescript-adk/issues/63)) ([d4a1053](https://github.com/inference-gateway/typescript-adk/commit/d4a10531a476c6c5615dd244b078862e275432b4)), closes [#8](https://github.com/inference-gateway/typescript-adk/issues/8)

## [0.4.0](https://github.com/inference-gateway/typescript-adk/compare/v0.3.0...v0.4.0) (2026-05-26)

### ✨ Features

* implement agent card discovery endpoint ([#62](https://github.com/inference-gateway/typescript-adk/issues/62)) ([42c36f0](https://github.com/inference-gateway/typescript-adk/commit/42c36f0b412fc76d4375db5bc0014dc5c9583dfc)), closes [#7](https://github.com/inference-gateway/typescript-adk/issues/7)

### 👷 CI

* add pnpm and npm to allowed bash commands ([bee4402](https://github.com/inference-gateway/typescript-adk/commit/bee4402d65ffe3dfb40b309b1b8948e1768cd295))

### 📚 Documentation

* add AGENTS.md ([db86085](https://github.com/inference-gateway/typescript-adk/commit/db8608552e39a6cf229b5fb73c77cdd20e89aee4))
* add CLAUDE.md ([ead8499](https://github.com/inference-gateway/typescript-adk/commit/ead849998d8717d74f70e2a00158d2f2de0c9555))

### 🔧 Miscellaneous

* add flox dev environment ([f96ff4b](https://github.com/inference-gateway/typescript-adk/commit/f96ff4b86bd1d28f98b45d7371589e4932cefdfe))
* **flox:** add pnpm to flox environment ([ddf3d16](https://github.com/inference-gateway/typescript-adk/commit/ddf3d16254f5a13e1e55f0745ee4e1f7d685260d))

## [0.3.0](https://github.com/inference-gateway/typescript-adk/compare/v0.2.0...v0.3.0) (2026-05-26)

### ✨ Features

* implement agent card data model and JSON loading ([#61](https://github.com/inference-gateway/typescript-adk/issues/61)) ([0cc1de1](https://github.com/inference-gateway/typescript-adk/commit/0cc1de1c51f613ee032bd649b789d6234aadf905)), closes [#6](https://github.com/inference-gateway/typescript-adk/issues/6)

## [0.2.0](https://github.com/inference-gateway/typescript-adk/compare/v0.1.1...v0.2.0) (2026-05-26)

### ✨ Features

* **a2a:** generate A2A protocol types from schemas repository ([#59](https://github.com/inference-gateway/typescript-adk/issues/59)) ([9f1696d](https://github.com/inference-gateway/typescript-adk/commit/9f1696d51c3cbe4541f3512223cfaa85aeb5194b)), closes [#5](https://github.com/inference-gateway/typescript-adk/issues/5)

### ♻️ Improvements

* **ci:** remove tokens and use trusted publisher ([0eaf23d](https://github.com/inference-gateway/typescript-adk/commit/0eaf23d07ad02683b094a6ebf1c56993ea7a2c96))

## [0.1.1](https://github.com/inference-gateway/typescript-adk/compare/v0.1.0...v0.1.1) (2026-05-26)

### 👷 CI

* fix release ([4efadae](https://github.com/inference-gateway/typescript-adk/commit/4efadae35d65dbe5d76fe620c618e28a50bbb4a9))

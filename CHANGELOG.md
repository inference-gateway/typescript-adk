# Changelog

All notable changes to this project will be documented in this file.

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

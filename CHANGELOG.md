# Changelog

All notable changes to this project will be documented in this file.

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

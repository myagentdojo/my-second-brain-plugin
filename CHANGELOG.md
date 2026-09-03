# Changelog

## [0.5.1](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.5.0...v0.5.1) (2026-09-03)


### Bug Fixes

* **packaging:** adopt agent plugin kit ([#60](https://github.com/myagentdojo/my-second-brain-plugin/issues/60)) ([cb4f755](https://github.com/myagentdojo/my-second-brain-plugin/commit/cb4f75532f3c52e22782b1591db2c1fe63af757a))

## [0.5.0](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.4.0...v0.5.0) (2026-08-30)


### Features

* **agent-browser:** implement the Warm Browser MVP ([#44](https://github.com/myagentdojo/my-second-brain-plugin/issues/44)) ([b6f4dd3](https://github.com/myagentdojo/my-second-brain-plugin/commit/b6f4dd3047502d6bdb884c04291143a80b93ea94))

## [0.4.0](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.3.0...v0.4.0) (2026-08-26)


### Features

* **plugin:** add NotebookLM and harness-aware development mode ([#34](https://github.com/myagentdojo/my-second-brain-plugin/issues/34)) ([76a06cc](https://github.com/myagentdojo/my-second-brain-plugin/commit/76a06cc3f6ae17bac320eaf0704e7e0f4442abbb))
* **plugin:** validate skill inventory and Codex install plans ([#30](https://github.com/myagentdojo/my-second-brain-plugin/issues/30)) ([28b7bcb](https://github.com/myagentdojo/my-second-brain-plugin/commit/28b7bcb7a057dfb5bd318213d60df33388e0d9a4))
* **skills:** make capability formation approval-safe ([#31](https://github.com/myagentdojo/my-second-brain-plugin/issues/31)) ([6da9692](https://github.com/myagentdojo/my-second-brain-plugin/commit/6da96924405114490d5672d0c39332857ba4420f))


### Bug Fixes

* **frontier-runner:** harden local launch setup ([#32](https://github.com/myagentdojo/my-second-brain-plugin/issues/32)) ([800432b](https://github.com/myagentdojo/my-second-brain-plugin/commit/800432b267b4f943b5efbe28808c0ab2ec5968de))
* **release:** preserve readiness identity on invalid config ([#33](https://github.com/myagentdojo/my-second-brain-plugin/issues/33)) ([e065f5f](https://github.com/myagentdojo/my-second-brain-plugin/commit/e065f5f732b322e1ec0bacc06e534c0b3a53f4d1))

## [0.3.0](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.2.0...v0.3.0) (2026-08-24)


### Features

* add receipt-backed Frontier Runner workflow ([#22](https://github.com/myagentdojo/my-second-brain-plugin/issues/22)) ([08698a5](https://github.com/myagentdojo/my-second-brain-plugin/commit/08698a5e4219d199118395b0af46e928999ba2a6))
* **dev:** report whether the payload came from the last successful build ([#14](https://github.com/myagentdojo/my-second-brain-plugin/issues/14)) ([e65c54b](https://github.com/myagentdojo/my-second-brain-plugin/commit/e65c54b1dd27ae372dd1f7f2255a3c60b9e8d1dc))


### Bug Fixes

* **dev:** detect a superseded development cache version ([#18](https://github.com/myagentdojo/my-second-brain-plugin/issues/18)) ([1fb8c03](https://github.com/myagentdojo/my-second-brain-plugin/commit/1fb8c03152ddb0b25e50b5bbd54d0a310a0b5b87))
* **dev:** name the production installation the install preview replaces ([#19](https://github.com/myagentdojo/my-second-brain-plugin/issues/19)) ([a2cbd06](https://github.com/myagentdojo/my-second-brain-plugin/commit/a2cbd06d43ad6e28bc34779bc3e6586ba1eab0eb))
* **test:** give the dev lifecycle cases an explicit subprocess budget ([#20](https://github.com/myagentdojo/my-second-brain-plugin/issues/20)) ([6dfcdcc](https://github.com/myagentdojo/my-second-brain-plugin/commit/6dfcdccf85f31d7501950f66f0ce6b4277816dd3))

## [0.2.0](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.1.2...v0.2.0) (2026-08-20)


### Features

* **dev:** add persistent Claude development installation ([#7](https://github.com/myagentdojo/my-second-brain-plugin/issues/7)) ([c34cf6b](https://github.com/myagentdojo/my-second-brain-plugin/commit/c34cf6bc01d8c94a77c5a27f84a7f42d5481d6fa))
* **dev:** detect an orphaned development cache and add a dev-mode skill ([#11](https://github.com/myagentdojo/my-second-brain-plugin/issues/11)) ([1a192dc](https://github.com/myagentdojo/my-second-brain-plugin/commit/1a192dcfe64fb5d797affcd53e414ebe6875c652))
* **skills:** add supervised Opus handoff ([#15](https://github.com/myagentdojo/my-second-brain-plugin/issues/15)) ([3cc23f6](https://github.com/myagentdojo/my-second-brain-plugin/commit/3cc23f6768e7aad9c3128144f1a185ab7d9b3b2d))


### Bug Fixes

* **dev:** let check read a profile installed from another checkout ([#13](https://github.com/myagentdojo/my-second-brain-plugin/issues/13)) ([312f0f1](https://github.com/myagentdojo/my-second-brain-plugin/commit/312f0f18aef1d3c6133a9dcbb5a3a0bb6cbb0577))
* **dev:** require an explicit recovery step on every lifecycle error ([#12](https://github.com/myagentdojo/my-second-brain-plugin/issues/12)) ([057ab2f](https://github.com/myagentdojo/my-second-brain-plugin/commit/057ab2f6b8c8823aa73ebeb23514480d7c291769))
* **skills:** split ultragoal activation by harness ([#10](https://github.com/myagentdojo/my-second-brain-plugin/issues/10)) ([b8d2654](https://github.com/myagentdojo/my-second-brain-plugin/commit/b8d265484d5a0b0a4ba7d4667e7f0c0ba03e8ee9))
* **test:** bind the check-without-snapshot fixture to the configured plugin name ([#16](https://github.com/myagentdojo/my-second-brain-plugin/issues/16)) ([73ff186](https://github.com/myagentdojo/my-second-brain-plugin/commit/73ff1865e2f10846874c0a55132a28434474b000))
* **test:** give the semver manifest table an explicit subprocess budget ([#17](https://github.com/myagentdojo/my-second-brain-plugin/issues/17)) ([5e94b94](https://github.com/myagentdojo/my-second-brain-plugin/commit/5e94b941f702d2f867e96bdfc18c82bf79b0a20a))

## [0.1.2](https://github.com/myagentdojo/my-second-brain-plugin/compare/v0.1.1...v0.1.2) (2026-08-16)


### Bug Fixes

* update repository identity after rename ([#5](https://github.com/myagentdojo/my-second-brain-plugin/issues/5)) ([25406c3](https://github.com/myagentdojo/my-second-brain-plugin/commit/25406c3f8edf4b3fff3c18de27b9bdaa178a8abe))

## [0.1.1](https://github.com/myagentdojo/my-second-brain/compare/v0.1.0...v0.1.1) (2026-08-16)


### Bug Fixes

* make My Second Brain development and release ready ([#3](https://github.com/myagentdojo/my-second-brain/issues/3)) ([e1eb9d5](https://github.com/myagentdojo/my-second-brain/commit/e1eb9d5573f30f214159dcb595a14403942a6fe3))

## 0.1.0 (2026-08-16)


### Features

* publish My Second Brain vault workflows ([#1](https://github.com/myagentdojo/my-second-brain/issues/1)) ([caf6a49](https://github.com/myagentdojo/my-second-brain/commit/caf6a49d2e074b3e67422900508389a580a594bb))

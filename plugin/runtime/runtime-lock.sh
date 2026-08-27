#!/bin/sh
# Generated from runtime/runtime.lock.json. Edit the source, then run bun run generate.
RUNTIME_LOCK_PROFILE='bun'
RUNTIME_LOCK_VERSION='1.4.0'

runtime_lock_select_asset() {
	case "$1" in
	darwin-arm64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-darwin-aarch64.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='25568657'
		RUNTIME_ASSET_ARCHIVE_SHA256='c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-darwin-aarch64/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='63558256'
		RUNTIME_ASSET_EXECUTABLE_SHA256='539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf'
		;;
	darwin-x64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-darwin-x64-baseline.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-x64-baseline.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='28579695'
		RUNTIME_ASSET_ARCHIVE_SHA256='da9b9f1b4ba766c6f299711f38dfaa98623e1ed9c40896aa53db803c52ec1fa0'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-darwin-x64-baseline/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='70704544'
		RUNTIME_ASSET_EXECUTABLE_SHA256='ca8a18d0116d7b6b19f53bb0d8c48e487c0757cab4dc3f4f8cc5e43a44cd75d8'
		;;
	linux-arm64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-linux-aarch64.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='36641863'
		RUNTIME_ASSET_ARCHIVE_SHA256='4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-linux-aarch64/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='80600240'
		RUNTIME_ASSET_EXECUTABLE_SHA256='086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9'
		;;
	linux-x64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-linux-x64-baseline.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64-baseline.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='36697583'
		RUNTIME_ASSET_ARCHIVE_SHA256='184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-linux-x64-baseline/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='80761952'
		RUNTIME_ASSET_EXECUTABLE_SHA256='33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b'
		;;
	*) return 1 ;;
	esac
}

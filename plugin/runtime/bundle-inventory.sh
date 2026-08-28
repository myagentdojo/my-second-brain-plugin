#!/bin/sh
# Generated from bundle-inventory.json by scripts/build.ts. Edit workspace sources, then run bun run build.
runtime_inventory_select_bundle() {
	case "$1" in
	'agent-browser')
		RUNTIME_BUNDLE_PATH='runtime/warm-browser-c58dd19c4f9820d7.js'
		RUNTIME_BUNDLE_BYTES='128776'
		RUNTIME_BUNDLE_SHA256='c58dd19c4f9820d7ca771dadc81a3fdf2c601441f97d0515bfecf8be9753387e'
		;;
	'frontier-runner')
		RUNTIME_BUNDLE_PATH='runtime/frontier-runner-659b5dedecb84722.js'
		RUNTIME_BUNDLE_BYTES='109683'
		RUNTIME_BUNDLE_SHA256='659b5dedecb84722818a2ea09f5c34bdeb58ebe07c27cb1ba59b836bb639d9db'
		;;
	'hello-world')
		RUNTIME_BUNDLE_PATH='runtime/hello-world.js'
		RUNTIME_BUNDLE_BYTES='995'
		RUNTIME_BUNDLE_SHA256='7fb7acb17dabccf51e13f33d5eb5b204ce6b9dc2c5629bee13c4b702f778d1d3'
		;;
	'skill-a')
		RUNTIME_BUNDLE_PATH='runtime/skill-a-8ca2c71e66871303.js'
		RUNTIME_BUNDLE_BYTES='7928'
		RUNTIME_BUNDLE_SHA256='8ca2c71e668713037c57ffa39f85bf6c82be830119cb30f285c85946dc0c9748'
		;;
	'skill-b')
		RUNTIME_BUNDLE_PATH='runtime/skill-b-a7d9599c270986ec.js'
		RUNTIME_BUNDLE_BYTES='6437'
		RUNTIME_BUNDLE_SHA256='a7d9599c270986ece563c9bdabd87f3ccc650deb505cdf10f3dd8905042c58f3'
		;;
	*) return 1 ;;
	esac
}

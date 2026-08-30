import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")

test("the root TypeScript 7 toolchain has the approved Bun configuration", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
	expect(packageJson.packageManager).toBe("bun@1.4.0")
	expect(packageJson.devDependencies).toEqual({
		"@types/bun": "1.4.0",
		typescript: "7.0.2",
	})
	expect(packageJson.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit")
	expect(packageJson.scripts["prove:all"]).toContain("bun run typecheck")

	const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))
	expect(tsconfig).toEqual({
		compilerOptions: {
			lib: ["ESNext"],
			target: "ESNext",
			module: "Preserve",
			moduleDetection: "force",
			types: ["bun"],
			moduleResolution: "bundler",
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			noEmit: true,
			strict: true,
			skipLibCheck: true,
			noFallthroughCasesInSwitch: true,
			noUncheckedIndexedAccess: true,
			noImplicitOverride: true,
			noUnusedLocals: false,
			noUnusedParameters: false,
			noPropertyAccessFromIndexSignature: false,
			rootDir: ".",
		},
		include: ["scripts/**/*.ts", "packages/**/*.ts"],
	})
})

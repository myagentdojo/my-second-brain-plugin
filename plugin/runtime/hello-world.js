// @bun
// Generated from runtime/src/. Edit source, then run bun run build.
function o(e="",t=""){return{exitCode:0,stdout:e,stderr:t}}function l(e){return{exitCode:2,stdout:"",stderr:`hello-world: ${e}
Run hello-world --help for usage.
`}}function u(e,t){let n=e.indexOf(t);if(n===-1)return;return e[n+1]}function m(){return`Usage:
  hello-world hello [--name <name>] [--json]
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
`}function d(e,t){let[n,...s]=e;if(n===void 0||n==="--help"||n==="-h")return o(m());if(n==="hello"){let i=u(s,"--name")??"world";if(s.includes("--json"))return o(`${JSON.stringify({ok:!0,command:"hello",message:`Hello, ${i}!`,sideEffects:"none",runId:t})}
`);return o(`Hello, ${i}!
`)}return l(`unknown command: ${n}`)}var r=d(process.argv.slice(2),process.env.HELLO_WORLD_RUN_ID??crypto.randomUUID());if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exit(r.exitCode);

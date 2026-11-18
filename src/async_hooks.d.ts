/**
 * Den del av `node:async_hooks` som src/bakgrund.ts använder. Workers har
 * modulen med `nodejs_compat` (wrangler.jsonc); src/ har inte Nodes typer.
 */
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		getStore(): T | undefined;
		run<R>(store: T, fn: () => R): R;
	}
}

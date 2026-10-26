// #1590: ambient surface of "react" for the dsh client bundle. The real
// module arrives at runtime through dsh's browser module system (the
// factory `require` of the __ModuleLoader__ wrapper) and is marked external
// in the client tsup build — no react devDependency is installed.
declare module "react" {
    export function createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
    // #1809/#2288: hooks used by the settings entry to track the live
    // /bili/origin route in place (the boot snapshot is only a first-paint hint).
    export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
    export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}

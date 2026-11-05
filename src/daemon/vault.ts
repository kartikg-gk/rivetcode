import { execFile } from "node:child_process";

export type VaultReference = { provider: string; account: string; reference: string };
export type VaultReader = (reference: VaultReference) => Promise<string>;

const onePassword: VaultReader = ({ account, reference }) => new Promise((resolve, reject) => {
  if (!account.trim() || account.length > 200 || !/^op:\/\/[^\s]+$/.test(reference) || reference.length > 1000) {
    reject(new Error("Provide a 1Password account and an op:// reference"));
    return;
  }
  execFile("op", ["--cache=false", "read", `--account=${account}`, "--no-newline", reference], {
    windowsHide: true, timeout: 45_000, maxBuffer: 20_000,
  }, (error, stdout) => {
    if (error || !stdout.trim()) {
      reject(new Error("The vault could not supply the secret. Check its CLI authentication and reference."));
      return;
    }
    resolve(stdout);
  });
});

export function vaultResolver(readers: Record<string, VaultReader> = { onepassword: onePassword }) {
  const cache = new Map<string, Promise<string>>();
  return {
    read(reference: VaultReference): Promise<string> {
      const reader = Object.hasOwn(readers, reference.provider) ? readers[reference.provider] : undefined;
      if (!reader) return Promise.reject(new Error("Unsupported vault provider"));
      const key = JSON.stringify(reference);
      let result = cache.get(key);
      if (!result) {
        result = reader(reference);
        cache.set(key, result);
      }
      return result;
    },
    invalidate(): void { cache.clear(); },
  };
}

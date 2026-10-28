import { rename, unlink, writeFile } from "node:fs/promises";

export type AtomicWriteOperations = {
	writeFile: (filePath: string, content: string, encoding: "utf-8") => Promise<void>;
	rename: (fromPath: string, toPath: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
};

const ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = {
	writeFile,
	rename,
	unlink,
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function writeFileAtomic(
	absPath: string,
	content: string,
	operations: AtomicWriteOperations = ATOMIC_WRITE_OPERATIONS,
): Promise<void> {
	const tempPath = `${absPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	await operations.writeFile(tempPath, content, "utf-8");
	try {
		await operations.rename(tempPath, absPath);
	} catch (error) {
		// Windows: rename over an existing file commonly surfaces as EPERM (antivirus or
		// indexer holding the destination open) instead of the POSIX-style EEXIST.
		if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "EPERM")) {
			throw error;
		}
		// Transient external locks can clear within milliseconds; one short retry before
		// unlinking the destination, which would otherwise destroy it while locked.
		if (hasErrorCode(error, "EPERM")) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			try {
				await operations.rename(tempPath, absPath);
				return;
			} catch (retryError) {
				if (!hasErrorCode(retryError, "EEXIST") && !hasErrorCode(retryError, "EPERM")) {
					throw retryError;
				}
			}
		}
		await operations.unlink(absPath);
		await operations.rename(tempPath, absPath);
	}
}

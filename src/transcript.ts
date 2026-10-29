import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export class AgentTranscript {
	private constructor(readonly file: string, private fd: number, private id: string, private cwd: string) {}

	static path(projectDir: string, id: string) { return join(projectDir, ".pi-subagents", "agent-transcripts", `${id}.jsonl`); }

	private static prepare(projectDir: string) {
		if (!statSync(projectDir).isDirectory()) throw new Error(`project directory is not a directory: ${projectDir}`);
		const root = join(projectDir, ".pi-subagents");
		const dir = join(root, "agent-transcripts");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try { writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try { execFileSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], { stdio: "ignore" }); }
			catch { return; }
			try { execFileSync("git", ["-C", projectDir, "check-ignore", "-q", join(dir, "probe.jsonl")], { stdio: "ignore" }); }
			catch { throw new Error(`existing .gitignore does not protect transcripts: ${dir}`); }
		}
	}

	static create(projectDir: string, id: string, cwd: string) {
		this.prepare(projectDir);
		const file = this.path(projectDir, id);
		return new AgentTranscript(file, openSync(file, "wx", 0o600), id, cwd);
	}

	static validate(file: string, id: string) {
		const data = readFileSync(file, "utf8");
		if (data && !data.endsWith("\n")) throw new Error(`transcript has an incomplete last line: ${file}`);
		for (const line of data.split("\n")) if (line) {
			const record = JSON.parse(line);
			if (record.agentId !== id) throw new Error(`transcript agent mismatch: ${file}`);
		}
	}

	static open(file: string, id: string, cwd: string) {
		this.validate(file, id);
		return new AgentTranscript(file, openSync(file, "a"), id, cwd);
	}

	static importLegacy(projectDir: string, id: string, cwd: string, sessionFile: string) {
		this.prepare(projectDir);
		const file = this.path(projectDir, id);
		if (existsSync(file)) { this.validate(file, id); return file; }
		const source = readFileSync(sessionFile, "utf8");
		if (!source.endsWith("\n")) throw new Error(`incomplete native session: ${sessionFile}`);
		const lines = source.trimEnd().split("\n").map((line) => JSON.parse(line));
		if (lines[0]?.type !== "session") throw new Error(`invalid native session: ${sessionFile}`);
		const temp = `${file}.${randomUUID()}.tmp`;
		const writer = new AgentTranscript(temp, openSync(temp, "wx", 0o600), id, cwd);
		try {
			for (const entry of SessionManager.open(sessionFile).getEntries()) {
				if (entry.type === "message") writer.append(entry.message, entry.timestamp);
				else if (entry.type === "custom_message") writer.append({ role: "custom", customType: entry.customType, content: entry.content, details: entry.details, display: entry.display }, entry.timestamp);
			}
			writer.close();
			linkSync(temp, file);
		} finally { writer.close(); unlinkSync(temp); }
		return file;
	}

	append<T extends { role: string }>(message: T, timestamp = new Date().toISOString()) {
		const data = Buffer.from(`${JSON.stringify({ isSidechain: true, agentId: this.id, type: message.role, message, timestamp, cwd: this.cwd })}\n`);
		let offset = 0;
		while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
	}

	close() {
		if (this.fd < 0) return;
		const fd = this.fd; this.fd = -1;
		try { fsyncSync(fd); } finally { closeSync(fd); }
	}
}

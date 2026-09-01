import { BadRequestException, Injectable } from '@nestjs/common';
import { fetchJson } from '../../hr-integration/providers/provider-util';
import type { SisSnapshot } from '../sis-snapshot.types';
import type { SisSnapshotProvider } from './sis-snapshot-provider';
import { buildSnapshot, emptyRows, type SisRawRows } from './snapshot-builder';

/**
 * Generic SIS provider — the catch-all for any student system without a pre-built
 * connector. Two source types:
 *   - 'rest': a JSON endpoint returning a bundle
 *       { students, guardians, teachers, teachingAssignments, enrollments } — each an
 *       array of rows using the same column names as the import template.
 *   - 'sftp': the same JSON bundle fetched from an SFTP path.
 * Rows are run through the shared snapshot builder, so the mapping/relationship logic
 * is identical to the Excel/CSV import.
 */
@Injectable()
export class GenericSisProvider implements SisSnapshotProvider {
  readonly name = 'Generic (REST / SFTP)';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<SisSnapshot> {
    const c = (options?.connection ?? {}) as Record<string, unknown>;
    const sourceType = String(c.sourceType ?? 'rest');
    let bundle: unknown;
    if (sourceType === 'rest') bundle = await this.fetchRest(c);
    else if (sourceType === 'sftp') bundle = await this.fetchSftp(c);
    else throw new BadRequestException(`Unknown Generic SIS source type "${sourceType}".`);
    return buildSnapshot(this.toRows(bundle));
  }

  private authHeaders(c: Record<string, unknown>): Record<string, string> {
    const authType = String(c.authType ?? 'none');
    if (authType === 'bearer' && c.token) return { Authorization: `Bearer ${String(c.token)}` };
    if (authType === 'apikey' && c.apiKey) return { [String(c.apiKeyHeader || 'X-API-Key')]: String(c.apiKey) };
    if (authType === 'basic' && c.username) return { Authorization: 'Basic ' + Buffer.from(`${String(c.username)}:${String(c.password ?? '')}`).toString('base64') };
    return {};
  }

  private async fetchRest(c: Record<string, unknown>): Promise<unknown> {
    const url = String(c.url ?? '').trim();
    if (!url) throw new BadRequestException('Generic SIS REST source needs a bundle URL.');
    return fetchJson(url, { headers: this.authHeaders(c) });
  }

  private async fetchSftp(c: Record<string, unknown>): Promise<unknown> {
    const host = String(c.host ?? '').trim();
    const remotePath = String(c.remotePath ?? '').trim();
    const username = String(c.username ?? '').trim();
    if (!host || !remotePath || !username) throw new BadRequestException('Generic SIS SFTP source needs host, username and file path.');
    let SftpClient: new () => { connect(cfg: unknown): Promise<unknown>; get(path: string): Promise<Buffer>; end(): Promise<void> };
    try { const req = eval('require') as NodeRequire; SftpClient = req('ssh2-sftp-client'); }
    catch { throw new BadRequestException('SFTP support is not installed (ssh2-sftp-client). Use REST, or install the dependency.'); }
    const client = new SftpClient();
    try {
      await client.connect({ host, port: Number(c.port) || 22, username, ...(c.privateKey ? { privateKey: String(c.privateKey) } : {}), ...(c.password ? { password: String(c.password) } : {}), readyTimeout: 20_000 });
      const buf = await client.get(remotePath);
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      try { return JSON.parse(text); } catch { throw new BadRequestException('The SFTP file is not valid JSON.'); }
    } catch (e) { throw new BadRequestException(`SFTP fetch failed: ${(e as Error).message}`); }
    finally { try { await client.end(); } catch { /* ignore */ } }
  }

  private toRows(bundle: unknown): SisRawRows {
    const b = (bundle ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    const rows = emptyRows();
    rows.students = arr(b.students);
    rows.guardians = arr(b.guardians ?? b.parents);
    rows.teachers = arr(b.teachers);
    rows.teachingAssignments = arr(b.teachingAssignments ?? b.assignments);
    rows.enrollments = arr(b.enrollments ?? b.enrolments);
    return rows;
  }
}

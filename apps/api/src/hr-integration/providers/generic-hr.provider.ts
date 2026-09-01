import { BadRequestException, Injectable } from '@nestjs/common';
import type { HrProvider, HrSnapshot } from '../hr-provider.interface';
import { atPath, buildSnapshotFromRows, fetchJson, fetchText, parseCsv, type FieldMapping } from './provider-util';

const DEFAULT_MAPPING: FieldMapping = {
  employeeCode: 'employeeCode', fullName: 'fullName', email: 'email',
  department: 'department', designation: 'designation', campus: 'campus',
  managerCode: 'managerCode', status: 'status', joinDate: 'joinDate',
  firstName: 'firstName', lastName: 'lastName',
};

/**
 * Generic HR provider — the catch-all for organizations whose HR system isn't a
 * pre-built option (or that have no modern HRIS at all). Three source types:
 *   - 'rest':    a JSON endpoint returning an array of employee objects.
 *   - 'csv_url': a CSV file fetched over HTTPS.
 *   - 'sftp':    a CSV file pulled from an SFTP server.
 * An admin-supplied field mapping (source key/column → our fields) is applied
 * uniformly; org structure is synthesized from the employee rows. Nothing about the
 * 360 sync/reconcile changes — this just produces the same HrSnapshot as any provider.
 */
@Injectable()
export class GenericHrProvider implements HrProvider {
  readonly name = 'Generic (REST / CSV / SFTP)';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<HrSnapshot> {
    const c = (options?.connection ?? {}) as Record<string, unknown>;
    const sourceType = String(c.sourceType ?? 'rest');
    const mapping: FieldMapping = { ...DEFAULT_MAPPING, ...(c.mapping && typeof c.mapping === 'object' ? (c.mapping as Partial<FieldMapping>) : {}) };
    const limit = typeof options?.limit === 'number' ? (options.limit as number) : undefined;

    let rows: Record<string, unknown>[];
    if (sourceType === 'rest') rows = await this.fetchRest(c);
    else if (sourceType === 'csv_url') rows = await this.fetchCsvUrl(c);
    else if (sourceType === 'sftp') rows = await this.fetchSftp(c);
    else throw new BadRequestException(`Unknown Generic source type "${sourceType}".`);

    if (limit && limit > 0) rows = rows.slice(0, limit);
    return buildSnapshotFromRows(rows, mapping, c.orgName ? String(c.orgName) : undefined);
  }

  private authHeaders(c: Record<string, unknown>): Record<string, string> {
    const authType = String(c.authType ?? 'none');
    if (authType === 'bearer' && c.token) return { Authorization: `Bearer ${String(c.token)}` };
    if (authType === 'apikey' && c.apiKey) return { [String(c.apiKeyHeader || 'X-API-Key')]: String(c.apiKey) };
    if (authType === 'basic' && c.username) return { Authorization: 'Basic ' + Buffer.from(`${String(c.username)}:${String(c.password ?? '')}`).toString('base64') };
    return {};
  }

  private async fetchRest(c: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const url = String(c.url ?? '').trim();
    if (!url) throw new BadRequestException('Generic REST source needs a URL.');
    const json = await fetchJson(url, { headers: this.authHeaders(c) });
    const arr = atPath(json, c.arrayPath ? String(c.arrayPath) : undefined);
    if (!Array.isArray(arr)) throw new BadRequestException('The REST response was not an array of employees (check the JSON path).');
    return arr.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
  }

  private async fetchCsvUrl(c: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const url = String(c.url ?? '').trim();
    if (!url) throw new BadRequestException('Generic CSV source needs a file URL.');
    const text = await fetchText(url, { headers: this.authHeaders(c) });
    return parseCsv(text, String(c.delimiter || ','));
  }

  private async fetchSftp(c: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const host = String(c.host ?? '').trim();
    const remotePath = String(c.remotePath ?? '').trim();
    const username = String(c.username ?? '').trim();
    if (!host || !remotePath || !username) throw new BadRequestException('Generic SFTP source needs host, username and file path.');

    // Lazy require so the module loads (and typechecks) even when the optional
    // ssh2-sftp-client dependency isn't installed; a clear error is raised if SFTP
    // is selected without it.
    let SftpClient: new () => { connect(cfg: unknown): Promise<unknown>; get(path: string): Promise<Buffer>; end(): Promise<void> };
    try {
      const req = eval('require') as NodeRequire;
      SftpClient = req('ssh2-sftp-client');
    } catch {
      throw new BadRequestException('SFTP support is not installed on the server (ssh2-sftp-client). Use the REST or CSV-over-HTTPS source, or install the dependency.');
    }

    const client = new SftpClient();
    try {
      await client.connect({
        host,
        port: Number(c.port) || 22,
        username,
        ...(c.privateKey ? { privateKey: String(c.privateKey) } : {}),
        ...(c.password ? { password: String(c.password) } : {}),
        readyTimeout: 20_000,
      });
      const buf = await client.get(remotePath);
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      return parseCsv(text, String(c.delimiter || ','));
    } catch (e) {
      throw new BadRequestException(`SFTP fetch failed: ${(e as Error).message}`);
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

import { pool } from '../client';
import { todayKey } from '@/utils/normalize';

export async function incrementDailyScan(telegramUserId: number): Promise<number> {
  const sql = `
    INSERT INTO usage_log (telegram_user_id, scan_date, scan_count, updated_at)
    VALUES ($1, $2, 1, NOW())
    ON CONFLICT (telegram_user_id, scan_date)
    DO UPDATE SET
      scan_count = usage_log.scan_count + 1,
      updated_at = NOW()
    RETURNING scan_count;
  `;
  const result = await pool.query(sql, [telegramUserId, todayKey()]);
  return result.rows[0].scan_count as number;
}

export async function getDailyScanCount(telegramUserId: number): Promise<number> {
  const result = await pool.query(
    `SELECT scan_count FROM usage_log WHERE telegram_user_id = $1 AND scan_date = $2`,
    [telegramUserId, todayKey()]
  );
  return result.rows[0]?.scan_count ?? 0;
}

export async function logScan(args: {
  telegramUserId: number;
  outcome: string;
  cacheHit: boolean;
  readConfidence?: number;
  durationMs?: number;
  medicineId?: number;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO scan_log (telegram_user_id, outcome, cache_hit, read_confidence, duration_ms, medicine_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        args.telegramUserId,
        args.outcome,
        args.cacheHit,
        args.readConfidence ?? null,
        args.durationMs ?? null,
        args.medicineId ?? null,
      ]
    );
  } catch {
    // Best effort
  }
}

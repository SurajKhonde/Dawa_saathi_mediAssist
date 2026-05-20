import { pool } from '../client';
import type { MedicineAnalysis, StoredMedicine } from '@/types';

/**
 * Insert or upsert a medicine analysis by ingredient key.
 * If the same ingredient combo is seen again, increment hit_count.
 */
export async function upsertMedicine(args: {
  ingredientKey: string;
  medicineName: string;
  analysis: MedicineAnalysis;
}): Promise<StoredMedicine> {
  const { ingredientKey, medicineName, analysis } = args;

  const sql = `
    INSERT INTO medicines (ingredient_key, medicine_name, analysis)
    VALUES ($1, $2, $3)
    ON CONFLICT (ingredient_key)
    DO UPDATE SET
      hit_count = medicines.hit_count + 1,
      updated_at = NOW()
    RETURNING id, ingredient_key, medicine_name, analysis, hit_count, created_at;
  `;
  const result = await pool.query(sql, [
    ingredientKey,
    medicineName,
    JSON.stringify(analysis),
  ]);

  const row = result.rows[0];
  return {
    id: row.id,
    ingredientKey: row.ingredient_key,
    medicineName: row.medicine_name,
    analysis: row.analysis as MedicineAnalysis,
    hitCount: row.hit_count,
    createdAt: row.created_at,
  };
}

/**
 * Look up a medicine by ingredient key (cache lookup). Returns null if not found.
 */
export async function findMedicineByKey(
  ingredientKey: string
): Promise<StoredMedicine | null> {
  const sql = `
    SELECT id, ingredient_key, medicine_name, analysis, hit_count, created_at
    FROM medicines
    WHERE ingredient_key = $1
    LIMIT 1;
  `;
  const result = await pool.query(sql, [ingredientKey]);
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    ingredientKey: row.ingredient_key,
    medicineName: row.medicine_name,
    analysis: row.analysis as MedicineAnalysis,
    hitCount: row.hit_count,
    createdAt: row.created_at,
  };
}

/**
 * Increment hit count when serving from Redis cache (for analytics).
 */
export async function incrementHitCount(id: number): Promise<void> {
  await pool.query(
    `UPDATE medicines SET hit_count = hit_count + 1, updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

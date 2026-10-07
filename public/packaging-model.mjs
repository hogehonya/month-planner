export const ITEMS = ['タマネギ','ニンニク','ネギ','カボチャ','ジャガイモ','サツマイモ','サトイモ','ラッカセイ','ミニチンゲンサイ','ハクサイ','シュンギク','ホウレンソウ','コマツナ','ダイコン','カブ','ニンジン','ビーツ','インゲン','レタス','ブロッコリー','エダマメ','トマト（大玉）','キャベツ','ショウガ'].map((name, index) => ({ id: `item-${String(index + 1).padStart(2, '0')}`, name }));
export const PHOTO_LIMIT = 3 * 1024 * 1024;
export function validateSKU(body) {
  if (!ITEMS.some(item => item.id === body.item_id)) throw new Error('品目を確認してください。');
  if (typeof body.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(body.id)) throw new Error('SKU IDは英数字・ハイフン・アンダースコアで80文字以内です。');
  const row = { item_id: body.item_id, id: body.id };
  for (const [field, max, label] of [['name',120,'SKU名'],['type',120,'品種・種類'],['note',3000,'備考'],['packaging_condition',3000,'荷姿条件']]) {
    const value = field === 'packaging_condition' ? body[field] ?? '' : body[field];
    if (typeof value !== 'string' || [...value].length > max || (field === 'name' && !value.trim())) throw new Error(`${label}を確認してください（${max}文字以内）。`);
    row[field] = value;
  }
  row.cultivation_method = body.cultivation_method ?? 'unknown';
  if (!['organic', 'conventional', 'unknown'].includes(row.cultivation_method)) throw new Error('栽培方法は有機・慣行・未確認から選んでください。');
  row.price_yen = body.price_yen ?? null;
  if (row.price_yen !== null && (!Number.isSafeInteger(row.price_yen) || row.price_yen < 0)) throw new Error('価格は0以上の整数円で入力してください。');
  return row;
}

export function validateSheet(body) {
  const date = body.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '0001-01-01' || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new Error('実在する予定日を入力してください。');
  if (!Array.isArray(body.rows) || body.rows.length > 500) throw new Error('販売準備表は500行以内で入力してください。');
  const seen = new Set();
  const rows = body.rows.map(row=> {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !ITEMS.some(item=>item.id === row.item_id) || typeof row.sku_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(row.sku_id)) throw new Error('SKUを確認してください。');
    const key = `${row.item_id}/${row.sku_id}`;
    if (seen.has(key)) throw new Error('同じSKUを重複して追加できません。'); seen.add(key);
    const next = {item_id:row.item_id,sku_id:row.sku_id};
    for (const field of ['price_yen','planned_quantity','prepared_quantity']) {
      if (row[field] !== null && (!Number.isSafeInteger(row[field]) || row[field] < 0)) throw new Error('単価・予定数・準備数は空欄または0以上の整数で入力してください。');
      next[field] = row[field];
    }
    next.decision_bits = row.decision_bits === undefined ? 0 : row.decision_bits;
    if (!Number.isInteger(next.decision_bits) || next.decision_bits < 0 || next.decision_bits > 7) throw new Error('確定状態は0〜7の整数です。');
    if (next.decision_bits & 2 && next.price_yen === null || next.decision_bits & 4 && next.planned_quantity === null) throw new Error('未入力の単価・必要数は確定できません。');
    return next;
  });
  return {date,rows};
}
export function summarizeSheet(rows) {
  const result = Object.fromEntries(['planned_quantity','prepared_quantity','planned_amount','prepared_amount'].map(key=>[key,{total:0n,unknown:0}]));
  for (const row of rows) for (const [quantity,amount] of [['planned_quantity','planned_amount'],['prepared_quantity','prepared_amount']]) {
    if (row[quantity] === null) result[quantity].unknown++; else result[quantity].total += BigInt(row[quantity]);
    if (row[quantity] === null || row.price_yen === null) result[amount].unknown++; else result[amount].total += BigInt(row[quantity]) * BigInt(row.price_yen);
  }
  return Object.fromEntries(Object.entries(result).map(([key,value])=>[key,{total:value.total.toString(),unknown:value.unknown}]));
}

export function decisionState(row,sku) { return (row.decision_bits ?? 0) | (sku?.photo_id ? 8 : 0); }

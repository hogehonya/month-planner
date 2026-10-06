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

export const CHECKLIST_FIELDS = { variety:'品種', cultivation:'有機・慣行', price:'価格', packaging:'荷姿', photo:'写真' };
export function validateChecklist(checks) {
  if (!checks || Array.isArray(checks) || typeof checks !== 'object' || Object.keys(checks).length !== Object.keys(CHECKLIST_FIELDS).length || Object.keys(checks).some(key=>!Object.hasOwn(CHECKLIST_FIELDS,key)) || Object.keys(CHECKLIST_FIELDS).some(key=>typeof checks[key] !== 'boolean')) throw new Error('チェックの項目を確認してください。');
  return Object.fromEntries(Object.keys(CHECKLIST_FIELDS).map(key=>[key,checks[key]]));
}

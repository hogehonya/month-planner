export const ITEMS = ['タマネギ','ニンニク','ネギ','カボチャ','ジャガイモ','サツマイモ','サトイモ','ラッカセイ','ミニチンゲンサイ','ハクサイ','シュンギク','ホウレンソウ','コマツナ','ダイコン','カブ','ニンジン','ビーツ','インゲン','レタス','ブロッコリー'].map((name, index) => ({ id: `item-${String(index + 1).padStart(2, '0')}`, name }));
export const PHOTO_LIMIT = 3 * 1024 * 1024;
export function validateSKU(body) {
  if (!ITEMS.some(item => item.id === body.item_id)) throw new Error('品目を確認してください。');
  if (typeof body.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(body.id)) throw new Error('SKU IDは英数字・ハイフン・アンダースコアで80文字以内です。');
  const row = { item_id: body.item_id, id: body.id };
  for (const [field, max, label] of [['name',120,'SKU名'],['type',120,'品種・種類'],['note',3000,'備考']]) {
    if (typeof body[field] !== 'string' || [...body[field]].length > max || (field === 'name' && !body[field].trim())) throw new Error(`${label}を確認してください（${max}文字以内）。`);
    row[field] = body[field];
  }
  return row;
}

const groups = [
  ['宇多田ヒカル', '宇多田光', 'Hikaru Utada', 'Utada Hikaru', 'Utada'],
  ['周杰伦', '周杰倫', 'Jay Chou', 'Jay'],
  ['陶喆', '陶喆 David Tao', 'David Tao', 'Tao'],
  ['The Beatles', 'Beatles'],
  ['坂本龍一', '坂本龙一', 'Ryuichi Sakamoto', 'Ryūichi Sakamoto'],
  ['王菲', '王菲 Faye Wong', 'Faye Wong'],
  ['方大同', '方大同 Khalil Fong', 'Khalil Fong'],
  ['陈绮贞', '陳綺貞', 'Cheer Chen'],
  ['蛋堡', 'Soft Lipa']
];
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
const aliases = new Map(groups.flatMap(group => group.map(name => [normalize(name), normalize(group[0])] )));

export function artistIdentityKey(value) {
  const key = normalize(value);
  return aliases.get(key) || key.replace(/^the/, '');
}

export function artistEquivalent(left, right) {
  return artistIdentityKey(left) === artistIdentityKey(right);
}

export function artistIdentityGroups(values) {
  const result = new Map();
  for (const value of values) {
    const label = String(value || '').trim();
    if (!label) continue;
    const key = artistIdentityKey(label);
    if (!result.has(key)) result.set(key, label);
  }
  return [...result.entries()].map(([key, label]) => ({ key, label }));
}

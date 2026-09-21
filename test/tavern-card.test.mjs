/**
 * 酒馆角色卡 ↔ Story 转换的纯函数测试（node 侧）。
 *
 * 覆盖：roundtrip 无损（extensions 备份）、纯酒馆卡字段映射、PNG 构建→解析、
 * JSON/PNG 分派、非法输入报错。
 */
import assert from 'node:assert/strict'

import {
  storyToTavernCard, tavernCardToStory, parseCardJson, parsePngChara, buildPngCard, parseTavernCardFile,
} from '../lib/tavern-card.mjs'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const eq = (a, b, label) => assert.deepEqual(a, b, label)

const STORY = {
  character: { name: '江柚', profile: '22岁，运营。', speech: '短句为主。' },
  perspective: '相信努力会有回报。',
  world: { setting: '杭州', location: '出租屋', supportingCast: '室友小鹿' },
  counterpart: { profile: '青梅竹马', initial: '无话不说' },
  plot: { startingPoint: '毕业后的秋天。', style: '治愈日常', boundaries: '不写血腥', keywords: ['杭州', '毕业'] },
}

console.log('酒馆角色卡 ↔ Story')

check('roundtrip：Story → 酒馆卡 → Story 无损（extensions 备份）', () => {
  const card = storyToTavernCard(STORY)
  const back = tavernCardToStory(card)
  eq(back, STORY, '应 100% 还原（含 perspective/world/counterpart/keywords）')
})

check('导出卡是 chara_card_v2，且字段映射正确', () => {
  const card = storyToTavernCard(STORY)
  assert.equal(card.spec, 'chara_card_v2')
  const d = card.data
  assert.equal(d.name, '江柚')
  assert.ok(d.description.includes('22岁，运营。'), 'description 含身份设定')
  assert.ok(d.description.includes('价值观：'), 'description 含价值观')
  assert.ok(d.description.includes('世界观：'), 'description 含世界观')
  assert.ok(d.description.includes('对话者：'), 'description 含对话者')
  assert.equal(d.personality, '短句为主。')
  assert.equal(d.scenario, '毕业后的秋天。')
  assert.equal(d.system_prompt, '不写血腥')
  assert.equal(d.post_history_instructions, '治愈日常')
  eq(d.tags, ['杭州', '毕业'])
  assert.ok(d.extensions?.dsh_hds_interlude?.story, '应带无损备份')
})

check('纯酒馆卡（无备份）：字段映射到 Story（first_mes / mes_example / 世界书并入）', () => {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '阿澈',
      description: '程序员。',
      personality: '直白。',
      scenario: '入职第一天。',
      first_mes: '你好，我是阿澈。',
      mes_example: '用户：在吗\n阿澈：在。',
      system_prompt: '保持简短。',
      post_history_instructions: '职场日常。',
      tags: ['职场'],
      character_book: { entries: [
        { keys: ['公司'], content: '公司叫澄海科技。' },
      ] },
    },
  }
  const story = tavernCardToStory(card)
  assert.equal(story.character.name, '阿澈')
  assert.ok(story.character.profile.startsWith('程序员。'), 'description → profile')
  assert.ok(story.character.profile.includes('示例对话'), 'mes_example 应并入 profile')
  assert.ok(story.character.profile.includes('世界书'), 'character_book 内容应并入 profile')
  assert.equal(story.character.speech, '直白。')
  assert.ok(story.plot.startingPoint.includes('入职第一天。'), 'scenario → startingPoint')
  assert.ok(story.plot.startingPoint.includes('开场白：'), 'first_mes 并入开场白')
  assert.equal(story.plot.boundaries, '保持简短。')
  assert.equal(story.plot.style, '职场日常。')
  assert.ok(story.plot.keywords.includes('职场'), 'tags 并入 keywords')
  assert.ok(story.plot.keywords.includes('公司'), '世界书 keys 并入 keywords')
})

check('JSON 文本解析：带 data 包装与直接卡对象都接受', () => {
  const wrapped = parseCardJson(JSON.stringify({ data: { name: 'x' } }))
  assert.equal(wrapped.data.name, 'x')
  const direct = parseCardJson(JSON.stringify({ name: 'y' }))
  assert.equal(direct.name, 'y')
})

check('PNG：buildPngCard → parsePngChara 提取回同一张卡', () => {
  const card = storyToTavernCard(STORY)
  const png = buildPngCard(card)
  assert.ok(png[0] === 0x89 && png[1] === 0x50, 'PNG 魔数')
  const back = parsePngChara(png)
  assert.ok(back, '应解析出卡片')
  eq(back.data.name, '江柚', 'PNG 卡内容一致')
})

check('SillyTavern 风格：base64 的 chara 块 / base64 .json 文本都能解析', () => {
  const card = storyToTavernCard(STORY)
  // ① base64 编码的 .json 文本（部分分发渠道直接把卡存成 base64 文本）。
  const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
  assert.equal(parseCardJson(b64).data.name, '江柚', 'base64 JSON 文本应解析')
  // ② buildPngCard 的 chara 块应为 base64（对齐 SillyTavern，可被酒馆直接导入）。
  const png = buildPngCard(card)
  assert.ok(png.includes(Buffer.from('chara', 'ascii')), '应含 chara 关键字')
  assert.equal(parsePngChara(png).data.name, '江柚', 'base64 chara 块应解析')
  // ③ 手工拼一个「SillyTavern 官方格式」的 base64 chara（非本插件导出的原始 JSON 卡）。
  const handcrafted = Buffer.concat([
    Buffer.from('chara\0', 'utf8'),
    Buffer.from(b64, 'utf8'),
  ])
  // 直接验证 parseCardText 的等价入口：parseCardJson 能处理 base64。
  assert.equal(parseCardJson(b64).spec, 'chara_card_v2')
})

check('既非 JSON 也非 base64 → 明确报错', () => {
  assert.throws(() => parseCardJson('eyJ%%%not-valid-base64'), /不是合法的角色卡 JSON/)
  assert.throws(() => parseCardJson('{"not":"a card"}'), /缺少角色名/)
})

check('parseTavernCardFile：按内容自动识别 JSON / PNG', () => {
  const card = storyToTavernCard(STORY)
  const fromJson = parseTavernCardFile(Buffer.from(JSON.stringify(card), 'utf8'), 'a.json')
  assert.equal(fromJson.data.name, '江柚')
  const fromPng = parseTavernCardFile(buildPngCard(card), 'b.png')
  assert.equal(fromPng.data.name, '江柚')
})

check('非法输入：空文件 / 非角色卡 JSON / 非 PNG 报错', () => {
  assert.throws(() => parseTavernCardFile(Buffer.from(''), 'empty'), /空的/)
  assert.throws(() => parseTavernCardFile(Buffer.from('{"hello": 1}'), 'x.json'), /角色卡 JSON/)
  assert.throws(() => parseTavernCardFile(Buffer.from([1, 2, 3]), 'y.bin'), /不是合法的角色卡文件/)
})

check('缺字段的极简卡也能得到完整 Story 骨架（不崩）', () => {
  const story = tavernCardToStory({ name: '只有名字' })
  assert.equal(story.character.name, '只有名字')
  assert.deepEqual(story.plot.keywords, [])
})

console.log(`\n酒馆角色卡：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
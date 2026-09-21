/**
 * 表情库与 face 适配的测试。
 *
 * 覆盖四件事：
 *   ① 表情库：落盘去重、按发送者分目录、按名字查找、清单与磁盘不一致时的行为；
 *   ② 收割：入站图片落盘、非图片不碰、失败不抛；
 *   ③ face：双向翻译、**清洗管线不吃 face**（这是最容易坏的一环）；
 *   ④ 安全：路径不越界、协议白名单。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  defaultStickerDir, senderDirName, contentHash, guessImageExt, writeSticker,
  readIndex, writeIndex, rememberSticker, listStickers, findStickerByName,
  stickerStats, OWN_DIR, looksLikeImagePath,
} from '../../lib/qq-im/sticker-store.js'
import { imageAttachmentsOf, harvestOne, harvestInboundImages } from '../../lib/qq-im/sticker-harvest.js'
import {
  humanizeFaces, materializeFaces, describeFace, protectFaces, restoreFaces,
  cleanKeepingFaces, splitKeepingFaces, hasFace,
} from '../../lib/qq-im/face.js'
import { cleanImText, splitImText } from '../../lib/im.js'
import { splitOutboundText } from '../../lib/qq-im/outbound.js'

let passed = 0
function check(label, fn) { fn(); passed += 1 }
async function checkAsync(label, fn, timeoutMs = 30000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT: "${label}" 超过 ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    await Promise.race([fn(), timeout]);
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

const tmpRoots = []
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-sticker-'))
  tmpRoots.push(dir)
  return dir
}

/** 造一张最小的合法 PNG（8 字节签名足够被当文件处理）。 */
function fakePng(seed = 1) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(String(seed))])
}

/* ════════════════════════════════════════════════════ 表情库 */

check('默认目录在 DSH_HOME 下，不跟工作区漂移', () => {
  const dir = defaultStickerDir('/fake/home/.dsh')
  // 关键性质：跨项目共享。跟着 workspace 走会让「换个项目就不会发表情了」。
  assert.ok(dir.includes('.dsh'), `应当在 .dsh 下：${dir}`)
  assert.ok(dir.includes('media') && dir.includes('stickers'), `应当在 media/stickers 下：${dir}`)
})

check('senderDirName 只留安全字符', () => {
  eq(senderDirName('A1B2C3D4E5F6'), 'from-A1B2C3D4', '常规 openid')
  eq(senderDirName('../../etc/passwd'), 'from-etcpassw', '路径穿越被剥掉（分隔符与 . 都不留）')
  eq(senderDirName(''), 'from-unknown', '空值有兜底')
  eq(senderDirName(null), 'from-unknown', 'null 有兜底')
})

check('contentHash 按内容判等（不是按 URL）', () => {
  // QQ 的图片 URL 每条都不同，同一张图发两次会得到两个 URL。
  // 只有内容 hash 才认得出「这就是同一张」。
  const a = contentHash(fakePng(1))
  const b = contentHash(fakePng(1))
  const c = contentHash(fakePng(2))
  eq(a, b, '同内容应当同 hash')
  assert.notEqual(a, c, '不同内容应当不同 hash')
  eq(contentHash(Buffer.alloc(0)), '', '空内容返回空串')
})

check('guessImageExt 认得 MIME 与扩展名', () => {
  eq(guessImageExt('image/png'), '.png', 'png')
  eq(guessImageExt('image/jpeg'), '.jpg', 'jpeg')
  eq(guessImageExt('image/gif'), '.gif', 'gif')
  eq(guessImageExt('', 'https://x.com/a.webp?t=1'), '.webp', '从 URL 推断（带 query）')
  eq(guessImageExt('application/octet-stream', 'a.bmp'), '.bmp', '从文件名推断')
  eq(guessImageExt('', ''), '.png', '认不出时兜底 png')
})

check('looksLikeImagePath 只认图片扩展名', () => {
  eq(looksLikeImagePath('a.PNG'), true, '大写也算')
  eq(looksLikeImagePath('a.txt'), false, 'txt 不算')
  eq(looksLikeImagePath(null), false, 'null 不算')
})

check('writeSticker 落盘 + 同内容去重', () => {
  const dir = mkTmp()
  const buf = fakePng(7)
  const first = writeSticker({ buffer: buf, dir, ext: '.png' })
  eq(first.created, true, '第一次应当写入')
  const second = writeSticker({ buffer: buf, dir, ext: '.png' })
  eq(second.created, false, '同内容第二次不应当重复写')
  eq(second.path, first.path, '应当返回同一个路径')
  eq(fs.readdirSync(dir).filter(f => f.endsWith('.png')).length, 1, '磁盘上只应有一张')
})

check('writeSticker 同内容不同扩展名也算已存在', () => {
  const dir = mkTmp()
  const buf = fakePng(8)
  writeSticker({ buffer: buf, dir, ext: '.png' })
  const again = writeSticker({ buffer: buf, dir, ext: '.jpg' })
  eq(again.created, false, '同内容不该因扩展名不同而重复存')
})

check('writeSticker 拒绝空内容与超大文件', () => {
  const dir = mkTmp()
  eq(writeSticker({ buffer: Buffer.alloc(0), dir }), null, '空内容')
  eq(writeSticker({ buffer: null, dir }), null, 'null')
  const huge = Buffer.alloc(11 * 1024 * 1024)
  eq(writeSticker({ buffer: huge, dir }), null, '超过 10MB 应当拒绝')
})

check('rememberSticker + readIndex 往返', () => {
  const dir = mkTmp()
  const file = path.join(dir, OWN_DIR, 'abc.png')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, fakePng(9))
  const rec = rememberSticker(dir, { path: file, name: '开心', source: 'mine' })
  eq(rec.name, '开心', '应当记下名字')
  const back = readIndex(dir)
  eq(back.length, 1, '清单应当有一条')
  eq(back[0].name, '开心', '名字应当读回')
})

check('rememberSticker 不覆盖已有名字', () => {
  const dir = mkTmp()
  const file = path.join(dir, 'x.png')
  fs.writeFileSync(file, fakePng(10))
  rememberSticker(dir, { path: file, name: '原名' })
  rememberSticker(dir, { path: file, name: '新名' })
  const back = readIndex(dir)
  eq(back.length, 1, '不该重复记')
  eq(back[0].name, '原名', '不该被覆盖')
})

check('listStickers 以磁盘为准（清单外的手工图也能列出）', () => {
  const dir = mkTmp()
  // 用户手工丢图，不写 index.json —— 这是预期用法，不该要求用户维护清单。
  fs.mkdirSync(path.join(dir, OWN_DIR), { recursive: true })
  fs.writeFileSync(path.join(dir, OWN_DIR, '手工.png'), fakePng(11))
  const all = listStickers(dir)
  eq(all.length, 1, '应当列出磁盘上的图')
  eq(all[0].name, '手工', '名字来自文件名')
})

check('listStickers 忽略非图片文件', () => {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, OWN_DIR), { recursive: true })
  fs.writeFileSync(path.join(dir, OWN_DIR, 'a.png'), fakePng(12))
  fs.writeFileSync(path.join(dir, OWN_DIR, 'readme.txt'), 'x')
  fs.writeFileSync(path.join(dir, 'index.json'), '{"stickers":[]}')
  eq(listStickers(dir).length, 1, '只应当列出图片')
})

check('findStickerByName：精确名 > 不区分大小写 > 唯一前缀', () => {
  const dir = mkTmp()
  const sub = path.join(dir, OWN_DIR)
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'a.png'), fakePng(21))
  fs.writeFileSync(path.join(sub, 'b.png'), fakePng(22))
  fs.writeFileSync(path.join(sub, 'c.png'), fakePng(23))
  rememberSticker(dir, { path: path.join(sub, 'a.png'), name: '开心' })
  rememberSticker(dir, { path: path.join(sub, 'b.png'), name: 'KaiXin' })
  rememberSticker(dir, { path: path.join(sub, 'c.png'), name: '开心果' })

  eq(findStickerByName(dir, '开心').name, '开心', '精确名优先')
  eq(findStickerByName(dir, 'kaixin').name, 'KaiXin', '不区分大小写')
  // 「开」既能前缀命中「开心」也能命中「开心果」——多个候选时不猜，如实返回 undefined。
  eq(findStickerByName(dir, '开'), undefined, '前缀命中多个时不猜')
})

check('findStickerByName 找不到返回 undefined（不猜）', () => {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, OWN_DIR), { recursive: true })
  fs.writeFileSync(path.join(dir, OWN_DIR, 'a.png'), fakePng(24))
  eq(findStickerByName(dir, '不存在的名字'), undefined, '找不到就该返回 undefined')
  eq(findStickerByName(dir, ''), undefined, '空查询返回 undefined')
})

check('stickerStats 统计自有与联系人', () => {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, OWN_DIR), { recursive: true })
  fs.mkdirSync(path.join(dir, 'from-AAA'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'from-BBB'), { recursive: true })
  fs.writeFileSync(path.join(dir, OWN_DIR, 'm.png'), fakePng(31))
  fs.writeFileSync(path.join(dir, 'from-AAA', 'a.png'), fakePng(32))
  fs.writeFileSync(path.join(dir, 'from-BBB', 'b.png'), fakePng(33))
  const stats = stickerStats(dir)
  eq(stats.total, 3, '总数')
  eq(stats.mine, 1, '自有 1 张')
  eq(stats.senders, 2, '两位联系人')
})

/* ════════════════════════════════════════════════════ 收割 */

check('imageAttachmentsOf 只挑 image/*，拒掉其它类型', () => {
  const msg = {
    attachments: [
      { content_type: 'image/png', url: 'https://x.com/a.png' },
      { content_type: 'voice', url: 'https://x.com/v.silk' },
      { content_type: 'video/mp4', url: 'https://x.com/v.mp4' },
      { content_type: 'image/gif', url: 'https://x.com/b.gif' },
      { content_type: 'image/png', url: 'file:///etc/passwd' },
      { content_type: 'image/png' },
    ],
  }
  const out = imageAttachmentsOf(msg)
  eq(out.length, 2, '只应当留下两条合法图片')
  eq(out[0].url, 'https://x.com/a.png', '第一条')
  eq(out[1].url, 'https://x.com/b.gif', '第二条')
})

check('imageAttachmentsOf 拒掉超大附件声明', () => {
  const msg = { attachments: [{ content_type: 'image/png', url: 'https://x.com/a.png', size: 50 * 1024 * 1024 }] }
  eq(imageAttachmentsOf(msg).length, 0, '声明超过 10MB 的应当提前拒掉')
})

check('imageAttachmentsOf 容忍缺失/畸形 attachments', () => {
  eq(imageAttachmentsOf({}), [], '没有 attachments')
  eq(imageAttachmentsOf({ attachments: null }), [], 'null')
  eq(imageAttachmentsOf({ attachments: [null, 'x', 42] }), [], '畸形条目')
})

await checkAsync('harvestOne 落盘到发送者子目录', async () => {
  const dir = mkTmp()
  const buf = fakePng(41)
  const fetchImpl = async () => ({ ok: true, async arrayBuffer() { return buf } })
  const written = await harvestOne({
    url: 'https://x.com/a.png', contentType: 'image/png',
    dir, sender: 'USER123456', fetchImpl,
  })
  assert.ok(written, '应当落盘成功')
  assert.ok(written.path.includes('from-USER1234'), `应当落在发送者目录：${written.path}`)
  eq(fs.existsSync(written.path), true, '文件应当存在')
  const idx = readIndex(dir)
  eq(idx.length, 1, '应当登记进清单')
  eq(idx[0].source, 'inbound', '来源标为 inbound')
})

await checkAsync('harvestOne 下载失败返回 null 且不抛', async () => {
  const dir = mkTmp()
  const boom = async () => { throw new Error('network down') }
  eq(await harvestOne({ url: 'https://x.com/a.png', contentType: 'image/png', dir, fetchImpl: boom }), null, '网络错误')
  const bad = async () => ({ ok: false, status: 404 })
  eq(await harvestOne({ url: 'https://x.com/a.png', contentType: 'image/png', dir, fetchImpl: bad }), null, '404')
})

await checkAsync('harvestInboundImages 统计新增与去重', async () => {
  const dir = mkTmp()
  const buf = fakePng(51)
  const fetchImpl = async () => ({ ok: true, async arrayBuffer() { return buf } })
  const msg = {
    attachments: [
      { content_type: 'image/png', url: 'https://x.com/a.png' },
      { content_type: 'image/png', url: 'https://x.com/b.png' }, // 同内容 → 去重
    ],
  }
  const r1 = await harvestInboundImages({ message: msg, dir, sender: 'U1', fetchImpl })
  eq(r1.saved, 2, '两张都处理了')
  eq(r1.created, 1, '同内容只新增一份')
  // 再收一次同样的内容：仍然 saved，但不新增。
  const r2 = await harvestInboundImages({ message: msg, dir, sender: 'U1', fetchImpl })
  eq(r2.created, 0, '重复内容不该再新增')
})

await checkAsync('harvestInboundImages 没有 dir 时直接返回（不崩）', async () => {
  const r = await harvestInboundImages({ message: { attachments: [] }, dir: '' })
  eq(r.saved, 0, '空目录应当安全返回')
})

/* ════════════════════════════════════════════════════ face */

check('describeFace：认识的说名字，不认识给可读兜底', () => {
  eq(describeFace(13), '呲牙', '常用 id')
  eq(describeFace('66'), '爱心', '字符串 id 也认')
  eq(describeFace(99999), '[表情99999]', '不认识时保留 id，不丢信息')
  eq(describeFace('abc'), '[表情]', '非数字')
})

check('describeFace：超范围 id 不回绕成负数（整数溢出回归）', () => {
  // 回归：早先这里 `key |= 0`（32 位**有符号**），超大 id 会回绕成负数——
  // `[face:4294967295]` 变成 `[表情-1]`、`[face:2147483648]` 变成
  // `[表情-2147483648]`，再经 humanizeFaces 拼进入站文本喂给模型。
  // 负数不是「不认识的表情」，而是不存在的东西；模型会当真去理解它。
  eq(describeFace('4294967295'), '[表情4294967295]', '2^32-1 不回绕成 -1')
  eq(describeFace('2147483648'), '[表情2147483648]', '2^31 不回绕成负数')
  eq(describeFace('99999999999'), '[表情99999999999]', '超安全整数也如实保留')
  eq(humanizeFaces('[face:4294967295]'), '[[表情4294967295]]', '入站文本里不出现负数')
  for (const id of [13, '66', 99999, 'abc', '4294967295', '2147483648']) {
    assert.ok(!/-/.test(describeFace(id)) || /^\[表情\]$/.test(describeFace(id)),
      `describeFace(${id}) 不该产出负数：${describeFace(id)}`)
  }
})

check('humanizeFaces：入站方向 [face:N] → [中文名]', () => {
  eq(humanizeFaces('你好[face:14]'), '你好[微笑]', '内联')
  eq(humanizeFaces('[face:13]'), '[呲牙]', '独占一行')
  eq(humanizeFaces('a[face: 66 ]b'), 'a[爱心]b', '容忍空格')
  eq(humanizeFaces('没有表情'), '没有表情', '无 face 时原样')
  eq(humanizeFaces(''), '', '空串')
})

check('materializeFaces：出站方向 [中文名] → [face:N]', () => {
  eq(materializeFaces('[呲牙]'), '[face:13]', '标准名')
  eq(materializeFaces('你好[微笑]'), '你好[face:0]', '内联')
  eq(materializeFaces('[face:14]'), '[face:14]', '已经是标准标记时不动')
})

check('materializeFaces 不碰认不出的方括号', () => {
  // 翻不出来就原样留着——猜一个脸比留着更糟。
  eq(materializeFaces('[图片]'), '[图片]', '未知标记保持原样')
  eq(materializeFaces('【随便什么】'), '【随便什么】', '中文方括号未知词保持原样')
})

check('protectFaces / restoreFaces 往返', () => {
  const { text, faces } = protectFaces('在吗[face:14]哦[face:13]')
  eq(faces, ['[face:14]', '[face:13]'], '应当记下两个片段')
  assert.ok(!text.includes('face:'), '保护后的文本不该含 face 标记')
  eq(restoreFaces(text, faces), '在吗[face:14]哦[face:13]', '还原应当一致')
})

check('**关键**：清洗管线会吃掉 face，保护后才留下', () => {
  // 这是本次改动最容易坏的一环，必须钉住。
  // 朴素 cleanImText 把 [face:14] 当「整行方括号旁白」删掉，
  // 于是「只发一个表情」会变成「这一轮什么都没说」。
  eq(cleanImText('[face:14]'), '', '朴素清洗确实会吞掉（这是要防的事）')
  eq(cleanKeepingFaces('[face:14]', cleanImText), '[face:14]', '保护后应当留下')
  eq(cleanKeepingFaces('在吗[face:14]', cleanImText), '在吗[face:14]', '内联的也该留下')
  // 但真正的旁白仍然要被删掉——保护不能顺手把旁白也放行了。
  eq(cleanKeepingFaces('（她犹豫了一下）', cleanImText), '', '真旁白仍须删除')
  eq(cleanKeepingFaces('（笑）在吗', cleanImText), '在吗', '行内旁白仍须删除')
})

check('**关键**：splitOutboundText 也会吃掉 face，splitKeepingFaces 包在外面才留得住', () => {
  // 分条同样过 cleanImText，所以纯 face 消息在旧链路里会变成空数组。
  eq(splitOutboundText('[face:14]'), [], '旧链路确实会吞掉（这是要防的事）')
  // 反直觉但必须记住：保护得包在**分条外面**。
  // splitImText 内部自己会再清洗一次，所以「先 cleanKeepingFaces 再 split」是没用的。
  eq(splitOutboundText(cleanKeepingFaces('[face:14]', cleanImText)), [], '先清洗再分条仍然会被第二遍吃掉')
  eq(splitKeepingFaces('[face:14]', splitImText), ['[face:14]'], '包在分条外面才留得住')
})

check('splitKeepingFaces 不放过真旁白（保护不能顺手放行）', () => {
  eq(splitKeepingFaces('（她犹豫了一下）', splitImText), [], '整行旁白仍须删除')
  eq(splitKeepingFaces('（笑）在吗', splitImText), ['在吗'], '行内旁白仍须删除')
  eq(splitKeepingFaces('正常的一句话。', splitImText), ['正常的一句话。'], '普通文本照常')
})

check('splitKeepingFaces 混合场景', () => {
  eq(splitKeepingFaces('在吗[face:14]', splitImText), ['在吗[face:14]'], '文字夹表情')
  eq(splitKeepingFaces('哈哈哈[face:13][face:13]', splitImText), ['哈哈哈[face:13][face:13]'], '连发两个表情')
})

check('hasFace 判定', () => {
  eq(hasFace('[face:14]'), true, '有')
  eq(hasFace('[微笑]'), false, '中文名不算标准标记')
  eq(hasFace('没有'), false, '没有')
})

check('纯 face 消息清洗后不为空（回到「这一轮说了话」）', () => {
  const out = cleanKeepingFaces('[face:66]', cleanImText)
  assert.ok(out.trim().length > 0, '不该被清成空——否则这轮会被当作没说话')
})

/* ════════════════════════════════════════════════════ 清理 */

for (const dir of tmpRoots) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
}

console.log(`表情库与 face：通过 ${passed} 项`)

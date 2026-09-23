/**
 * 图片通路测试：来源校验、有序收集、图/文混发、图片失败降级、重试不重新生成。
 *
 * 这一层是「模型能发表情包」的全部机制所在，所以既验证能发的路径，
 * 也验证**发不出去时**的行为——降级与拒绝同样是需求的一部分。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  normalizeImageSource, normalizeItem, looksLikeImageSource, deliverMessages,
} from '../../lib/qq-im/outbound.js'
import { imageOfToolCall, collectOrderedItems, collectImages } from '../../lib/qq-im/say.js'

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

/* ------------------------------------------------------------ 来源校验 */

check('http/https URL 被接受', () => {
  eq(normalizeImageSource({ url: 'https://x.com/a.png' }), { url: 'https://x.com/a.png' }, 'https 应当通过')
  eq(normalizeImageSource({ url: 'http://x.com/a.png' }), { url: 'http://x.com/a.png' }, 'http 应当通过')
})

check('本地路径被接受', () => {
  eq(normalizeImageSource({ localPath: 'D:/pics/a.png' }), { localPath: 'D:/pics/a.png' }, 'localPath 应当通过')
  eq(normalizeImageSource({ file_path: 'D:/pics/a.png' }), { localPath: 'D:/pics/a.png' }, 'file_path 别名应当通过')
})

check('裸字符串按 URL/路径自动判断', () => {
  eq(normalizeImageSource('https://x.com/a.png'), { url: 'https://x.com/a.png' }, 'URL 字符串')
  eq(normalizeImageSource('D:/pics/a.png'), { localPath: 'D:/pics/a.png' }, '路径字符串')
})

check('file: / data: 协议一律拒绝（安全边界）', () => {
  // 这两条是安全不变量：url 会交给 QQ 服务器拉取，
  // 放行 file: 等于开一个读本机任意文件的口子。
  eq(normalizeImageSource({ url: 'file:///C:/Windows/win.ini' }), null, 'file: 必须被拒')
  eq(normalizeImageSource({ url: 'data:image/png;base64,AAAA' }), null, 'data: 必须被拒')
  eq(normalizeImageSource({ url: 'ftp://x.com/a.png' }), null, 'ftp 必须被拒')
})

check('空/非法输入返回 null', () => {
  eq(normalizeImageSource({}), null, '空对象')
  eq(normalizeImageSource(''), null, '空串')
  eq(normalizeImageSource(undefined), null, 'undefined')
  eq(normalizeImageSource(null), null, 'null')
})

check('looksLikeImageSource 只对图片扩展名放行', () => {
  eq(looksLikeImageSource({ localPath: 'a.PNG' }), true, '大写扩展名也算')
  eq(looksLikeImageSource({ localPath: 'a.webp' }), true, 'webp')
  eq(looksLikeImageSource({ localPath: 'a.txt' }), false, 'txt 不算图片')
  eq(looksLikeImageSource({ localPath: 'a' }), false, '无扩展名不算')
  eq(looksLikeImageSource({ url: 'https://x.com/whatever.mp4' }), true, 'URL 不查扩展名（交给 QQ 侧）')
})

/* ------------------------------------------------------------ 条目归一化 */

check('normalizeItem：字符串 → 文字条目', () => {
  eq(normalizeItem('你好'), { kind: 'text', text: '你好' }, '普通字符串')
  eq(normalizeItem('   '), null, '纯空白应当丢弃')
  eq(normalizeItem(''), null, '空串应当丢弃')
})

check('normalizeItem：图片对象 → 图片条目', () => {
  eq(
    normalizeItem({ kind: 'image', source: { url: 'https://x.com/a.png' } }),
    { kind: 'image', source: { url: 'https://x.com/a.png' } },
    '标准形态',
  )
  eq(
    normalizeItem({ image: { localPath: 'D:/a.png' } }),
    { kind: 'image', source: { localPath: 'D:/a.png' } },
    '简写形态',
  )
})

/* ------------------------------------------------------------ 工具调用提取 */

const toolCall = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

check('imageOfToolCall：取出 file_path / url', () => {
  eq(
    imageOfToolCall(toolCall('interlude_send_image', { file_path: 'D:/pics/a.png' })),
    { kind: 'image', source: { localPath: 'D:/pics/a.png' } },
    'file_path',
  )
  eq(
    imageOfToolCall(toolCall('interlude_send_image', { url: 'https://x.com/a.gif' })),
    { kind: 'image', source: { url: 'https://x.com/a.gif' } },
    'url',
  )
})

check('imageOfToolCall：非发图工具/坏 JSON/非法来源 → null', () => {
  eq(imageOfToolCall(toolCall('interlude_say', { text: 'hi' })), null, '别的工具不算')
  eq(imageOfToolCall({ type: 'tool/call', data: { name: 'interlude_send_image', arguments: '{oops' } }), null, '坏 JSON 不猜')
  eq(imageOfToolCall(toolCall('interlude_send_image', { url: 'file:///etc/passwd' })), null, 'file: 被拒')
  eq(imageOfToolCall(toolCall('interlude_send_image', { file_path: 'C:/secret.txt' })), null, '非图片扩展名被拒')
  eq(imageOfToolCall(toolCall('interlude_send_image', {})), null, '没给来源')
})

/*
 * 回归：`interlude_send_image({ name })` 是**工具文档首推的用法**
 * （"最省事的用法是只给 name（如「开心」），会从表情库里找"）。
 *
 * 修之前 imageOfToolCall 不认 name → 图片被**静默丢弃**，而工具 execute 还回答
 * "已记下表情「开心」，将在本回合结束时发送"——模型以为发出去了，用户什么都没收到。
 * 这类失败不报错、不留痕，只能靠用例钉住。
 */
check('imageOfToolCall：只给 name 时用注入的 resolver 解析出路径（回归）', () => {
  const resolved = []
  const image = imageOfToolCall(
    toolCall('interlude_send_image', { name: '开心' }),
    'interlude_send_image',
    { resolveSticker: (name) => { resolved.push(name); return 'D:/stickers/mine/开心.png' } },
  )
  eq(resolved, ['开心'], 'resolver 应收到模型给的表情名')
  eq(image, { kind: 'image', source: { localPath: 'D:/stickers/mine/开心.png' } }, '应解析成本地图片')
})

check('imageOfToolCall：name 但没有 resolver → null（不伪造路径）', () => {
  eq(imageOfToolCall(toolCall('interlude_send_image', { name: '开心' })), null,
    '没有 resolver 时返回 null，让上层如实报错')
})

check('imageOfToolCall：resolver 抛错 / 返回空 → 安静降级为 null', () => {
  const boom = () => { throw new Error('disk gone') }
  eq(imageOfToolCall(toolCall('interlude_send_image', { name: 'x' }), 'interlude_send_image', { resolveSticker: boom }), null,
    'resolver 抛错不该穿透')
  eq(imageOfToolCall(toolCall('interlude_send_image', { name: 'x' }), 'interlude_send_image', { resolveSticker: () => undefined }), null,
    '库里没有这个名字 → null')
})

check('显式 file_path 优先于 name（给了确切来源就用确切的）', () => {
  const image = imageOfToolCall(
    toolCall('interlude_send_image', { name: '开心', file_path: 'D:/exact/b.png' }),
    'interlude_send_image',
    { resolveSticker: () => 'D:/stickers/mine/开心.png' },
  )
  eq(image, { kind: 'image', source: { localPath: 'D:/exact/b.png' } }, 'file_path 优先')
})

check('collectOrderedItems 也解析 name（交互式收集走的是它）', () => {
  const { items, images } = collectOrderedItems(
    [toolCall('interlude_send_image', { name: '无语' })],
    { resolveSticker: () => 'D:/stickers/mine/无语.png' },
  )
  eq(images.length, 1, '应收集到 1 张')
  eq(items[0], { kind: 'image', source: { localPath: 'D:/stickers/mine/无语.png' } }, '条目应是解析后的图片')
})

/* ------------------------------------------------------------ 有序收集 */

check('图片与文字按调用顺序交错（顺序是需求，不是实现细节）', () => {
  // 「先甩张图再补一句」和「先说一句再甩图」必须是两种不同的结果。
  const imageFirst = collectOrderedItems([
    toolCall('interlude_send_image', { file_path: 'D:/pics/a.png' }),
    toolCall('interlude_say', { text: '看这个' }),
  ])
  eq(
    imageFirst.items,
    [{ kind: 'image', source: { localPath: 'D:/pics/a.png' } }, '看这个'],
    '图应该排在文字前面',
  )

  const textFirst = collectOrderedItems([
    toolCall('interlude_say', { text: '给你看个东西' }),
    toolCall('interlude_send_image', { file_path: 'D:/pics/a.png' }),
  ])
  eq(
    textFirst.items,
    ['给你看个东西', { kind: 'image', source: { localPath: 'D:/pics/a.png' } }],
    '文字应该排在图片前面',
  )
})

check('多图多文保持完整顺序', () => {
  const { items, texts, images } = collectOrderedItems([
    toolCall('interlude_send_image', { url: 'https://x.com/1.gif' }),
    toolCall('interlude_say', { text: '哈哈' }),
    toolCall('interlude_send_image', { file_path: 'C:/p/2.webp' }),
  ])
  eq(items.length, 3, '应当有 3 个条目')
  eq(items[0].kind, 'image', '第 1 条是图')
  eq(items[1], '哈哈', '第 2 条是文字')
  eq(items[2].kind, 'image', '第 3 条是图')
  eq(texts, ['哈哈'], 'texts 只含文字')
  eq(images.length, 2, 'images 含两张图')
})

check('collectImages 便捷函数', () => {
  const images = collectImages([
    toolCall('interlude_send_image', { url: 'https://x.com/1.png' }),
    toolCall('interlude_say', { text: 'hi' }),
    toolCall('interlude_send_image', { url: 'https://x.com/2.png' }),
  ])
  eq(images.length, 2, '应当取到两张图')
})

/* ------------------------------------------------------------ 混发投递 */

await checkAsync('图/文混发：顺序与条目形态都传给 send', async () => {
  const seen = []
  const result = await deliverMessages({
    send: async (targetId, chunk) => { seen.push(chunk); return { sent: true } },
    targetId: 'USER',
    messages: [
      { kind: 'image', source: { localPath: 'D:/a.png' } },
      '看这个',
      { kind: 'image', source: { url: 'https://x.com/b.gif' } },
    ],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, true, '应当成功')
  eq(result.sentCount, 3, '应当送出 3 条')
  eq(seen[0], { kind: 'image', source: { localPath: 'D:/a.png' } }, '第 1 条是图片条目')
  eq(seen[1], '看这个', '第 2 条是**字符串**（与既有调用方兼容）')
  eq(seen[2], { kind: 'image', source: { url: 'https://x.com/b.gif' } }, '第 3 条是图片条目')
})

await checkAsync('图片失败 → 降级成文字继续发，整轮仍算成功', async () => {
  const seen = []
  const result = await deliverMessages({
    send: async (targetId, chunk) => {
      seen.push(chunk)
      if (chunk && typeof chunk === 'object') throw Object.assign(new Error('upload failed'), { code: 'qq-upload-failed' })
      return { sent: true }
    },
    targetId: 'USER',
    messages: ['先说一句', { kind: 'image', source: { localPath: 'D:/a.png' } }],
    chunking: { minIntervalMs: 0 },
    onImageError: () => '[图片发送失败]',
  })
  eq(result.ok, true, '降级后整轮应当成功')
  eq(result.degraded, 1, '应当记 1 条降级')
  eq(result.sentCount, 2, '降级消息也要计入送达数')
  // seen 的顺序：文字 → 图片（失败）→ 降级文案。降级文案是**补发**的，
  // 所以它排在失败的那次尝试之后。
  eq(seen[0], '先说一句', '第 1 条是原文字')
  eq(seen[2], '[图片发送失败]', '失败的图片之后应当补发降级文案')
})

await checkAsync('没有 onImageError 时图片失败 → 整轮失败', async () => {
  const result = await deliverMessages({
    send: async (targetId, chunk) => {
      if (chunk && typeof chunk === 'object') throw Object.assign(new Error('boom'), { code: 'qq-upload-failed' })
      return { sent: true }
    },
    targetId: 'USER',
    messages: [{ kind: 'image', source: { localPath: 'D:/a.png' } }],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, false, '不可降级时应当失败')
  eq(result.error, 'qq-upload-failed', '应当带上错误码')
})

await checkAsync('图片失败时 remaining 保留图片条目（重试不重新生成）', async () => {
  const result = await deliverMessages({
    send: async (targetId, chunk) => {
      if (chunk && typeof chunk === 'object') throw Object.assign(new Error('boom'), { code: 'net' })
      return { sent: true }
    },
    targetId: 'USER',
    messages: ['先说的', { kind: 'image', source: { url: 'https://x.com/a.png' } }, '后说的'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, false, '应当失败')
  eq(result.sentCount, 1, '第一条文字已送达')
  // 支点：remaining 里图片仍是**图片条目**，重发时还是发那张图，不会退化成文字。
  eq(result.remaining.length, 2, '应当剩 2 条')
  eq(result.remaining[0].kind, 'image', 'remaining 第一条仍是图片条目')
  eq(result.remaining[1], '后说的', '文字仍是字符串形态')
})

await checkAsync('纯文本路径不受影响（向后兼容）', async () => {
  const seen = []
  const result = await deliverMessages({
    send: async (targetId, chunk) => { seen.push(chunk); return { sent: true } },
    targetId: 'U',
    messages: ['一', '二'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, true, '应当成功')
  // 老调用方按字符串断言——归一化不能改变外部可见形态。
  eq(seen, ['一', '二'], 'send 收到的应当还是字符串')
  eq(result.remaining, undefined, '成功时没有 remaining')
})

await checkAsync('无法归一化的条目被丢弃，不产生空投递', async () => {
  const seen = []
  const result = await deliverMessages({
    send: async (targetId, chunk) => { seen.push(chunk); return { sent: true } },
    targetId: 'U',
    messages: ['', '  ', { kind: 'image', source: { url: 'file:///x' } }, '有效'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, true, '有效条目仍应送出')
  eq(seen, ['有效'], '只应当送出有效的那一条')
})

/* ------------------------------------------------------------ 存在性校验 */

check('返回的 localPath 可用于存在性检查（供工具层报错）', () => {
  // 工具层在调用时就查文件是否存在——路径写错要让模型**当场**知道，
  // 而不是等投递失败。这里验证返回的形态确实带着可检查的路径。
  const src = normalizeImageSource({ file_path: 'D:/nope/a.png' })
  eq(typeof src.localPath, 'string', '应当带 localPath')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-img-'))
  try {
    const real = path.join(tmp, 'a.png')
    fs.writeFileSync(real, 'x')
    const ok = normalizeImageSource({ file_path: real })
    eq(fs.existsSync(ok.localPath), true, '真实存在的文件应当能被确认')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

console.log(`图片通路：通过 ${passed} 项`)

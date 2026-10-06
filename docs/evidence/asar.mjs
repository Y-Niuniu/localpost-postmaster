import fs from 'node:fs'

const asarPath = "C:/Users/16548/AppData/Local/Programs/DeepSeek Harness/resources/app.asar"
const fd = fs.openSync(asarPath, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const pickleSize = sizeBuf.readUInt32LE(4)
const headBuf = Buffer.alloc(pickleSize)
fs.readSync(fd, headBuf, 0, pickleSize, 8)
const text = headBuf.toString('utf8')
const header = JSON.parse(text.slice(text.indexOf('{')))
const dataOffset = 8 + pickleSize

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files || {})) {
    const full = prefix ? prefix + '/' + name : name
    if (value.files) walk(value, full, out)
    else out.push({ path: full, size: value.size, offset: value.offset })
  }
}
const all = []
walk(header, '', all)
const pattern = process.argv[2]
const limit = Number(process.argv[3] || 40)
if (pattern) {
  const re = new RegExp(pattern, 'i')
  const hits = all.filter(x => re.test(x.path) && x.path.endsWith('.js') && !/\.min\.js$/.test(x.path))
  console.log('entries total', all.length, '| matches', hits.length)
  for (const h of hits.slice(0, limit)) console.log('  ' + h.size.toString().padStart(9) + '  ' + h.path)
} else {
  console.log('entries total', all.length)
}
const extract = process.argv[4]
if (extract) {
  const entry = all.find(x => x.path === extract)
  if (!entry) { console.log('NOT FOUND: ' + extract); process.exit(1) }
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
  fs.writeFileSync(process.argv[5] || 'C:/AI_ASSIST/work/localpost-six-gates-evidence/asar-extract.js', buf)
  console.log('extracted ' + entry.size + ' bytes -> ' + (process.argv[5] || 'work/.../asar-extract.js'))
}
fs.closeSync(fd)

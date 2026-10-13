// Read selected packaged files without modifying the official desktop archive.
const fs = require('node:fs');
const path = require('node:path');
const archive = path.resolve(__dirname, '../resources/app.asar');
function openArchive() {
  const fd = fs.openSync(archive, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const header = Buffer.alloc(prefix.readUInt32LE(12));
  fs.readSync(fd, header, 0, header.length, 16);
  const tree = JSON.parse(header);
  const base = 8 + prefix.readUInt32LE(4);
  function read(name) {
    let entry = tree;
    for (const part of name.split('/')) entry = entry.files?.[part];
    if (!entry || entry.files) throw new Error(`Missing archive file: ${name}`);
    if (entry.unpacked) return fs.readFileSync(`${archive}.unpacked/${name}`, 'utf8');
    const bytes = Buffer.alloc(entry.size);
    fs.readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
    return bytes.toString('utf8');
  }
  return { tree, read, close: () => fs.closeSync(fd) };
}
module.exports = { openArchive };
if (require.main === module) {
  const a = openArchive();
  try { for (const name of process.argv.slice(2)) console.log(`FILE ${name}\n${a.read(name).replace(/^\/\/# sourceMappingURL=.*$/gm, '')}`); }
  finally { a.close(); }
}

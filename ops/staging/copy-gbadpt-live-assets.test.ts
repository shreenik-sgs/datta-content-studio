import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("repairs checksum-only migration damage but refuses changed media and invalid source checksums", () => {
  const result = execFileSync(
    "python3",
    [
      "-c",
      `
import base64, copy, importlib.util, sys
spec = importlib.util.spec_from_file_location('assets', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
source = {'Metadata': {'sha256': 'a' * 64}, 'ContentLength': 20,
          'ContentType': 'video/mp4', 'ServerSideEncryption': 'AES256',
          'ChecksumType': 'FULL_OBJECT', 'ChecksumSHA256': base64.b64encode(bytes.fromhex('a' * 64)).decode()}
assert m.repair_needed(source, None)
assert not m.repair_needed(source, copy.deepcopy(source))
crc = copy.deepcopy(source)
crc.pop('ChecksumSHA256')
crc['ChecksumCRC64NVME'] = 'another-algorithm'
assert m.repair_needed(source, crc)
composite = copy.deepcopy(source)
composite['ChecksumType'] = 'COMPOSITE'
composite['ChecksumSHA256'] = base64.b64encode(bytes.fromhex('b' * 64)).decode() + '-3'
assert not m.repair_needed(source, composite)
for changes in ({'ContentLength': 21}, {'ContentType': 'image/png'},
                {'Metadata': {'sha256': 'b' * 64}}, {'ServerSideEncryption': 'aws:kms'},
                {'ChecksumSHA256': base64.b64encode(bytes.fromhex('b' * 64)).decode()}):
    damaged = {**source, **changes}
    try:
        m.repair_needed(source, damaged)
        raise AssertionError('changed content accepted')
    except ValueError:
        pass
try:
    m.repair_needed(crc, source)
    raise AssertionError('invalid source accepted')
except ValueError:
    pass
print('verified')
`,
      fileURLToPath(new URL("./copy-gbadpt-live-assets.py", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  expect(result.trim()).toBe("verified");
});

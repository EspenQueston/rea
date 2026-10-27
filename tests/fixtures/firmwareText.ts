const byte = (value: number): string => value.toString(16).padStart(2, "0");

const addressBytes = (type: number): number => {
  if (type === 2 || type === 6 || type === 8) return 3;
  if (type === 3 || type === 7) return 4;
  return 2;
};

/** Build one Intel HEX record with a valid checksum. */
export const intelHexRecord = (
  type: number,
  address: number,
  data: Uint8Array = Buffer.alloc(0),
): string => {
  const body = Buffer.from([
    data.length,
    (address >>> 8) & 0xff,
    address & 0xff,
    type,
    ...data,
  ]);
  const checksum =
    (0x100 - (body.reduce((total, value) => total + value, 0) & 0xff)) & 0xff;
  return `:${Buffer.concat([body, Buffer.from([checksum])])
    .toString("hex")
    .toUpperCase()}`;
};

/** Build one Motorola S-record with a valid checksum. */
export const srecRecord = (
  type: number,
  address: number,
  data: Uint8Array = Buffer.alloc(0),
): string => {
  const width = addressBytes(type);
  const addressData = Buffer.alloc(width);
  let remaining = address;
  for (let index = width - 1; index >= 0; index -= 1) {
    addressData[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  const count = width + data.length + 1;
  const body = Buffer.concat([
    Buffer.from([count]),
    addressData,
    Buffer.from(data),
  ]);
  const checksum =
    (0xff - (body.reduce((total, value) => total + value, 0) & 0xff)) & 0xff;
  return `S${String(type)}${byte(count)}${addressData.toString("hex").toUpperCase()}${Buffer.from(data).toString("hex").toUpperCase()}${byte(checksum).toUpperCase()}`;
};

export const intelHexImage = (records: readonly string[]): Buffer =>
  Buffer.from(`${records.join("\n")}\n`, "ascii");

export const srecImage = (records: readonly string[]): Buffer =>
  Buffer.from(`${records.join("\n")}\n`, "ascii");

export const bytes = (...values: number[]): Buffer => Buffer.from(values);

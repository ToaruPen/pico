export type StackChanFieldArguments = ReadonlyMap<string, string | true>;

export function parseStackChanFieldArguments(
  arguments_: readonly string[],
  allowedOptions: ReadonlySet<string>
): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error("field arguments must use named --options");
    }
    if (!allowedOptions.has(name)) {
      throw new Error(`unknown option: ${name}`);
    }
    if (name === "--enable-live-run") {
      values.set(name, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  return values;
}

export function requireStackChanFieldStringArgument(
  values: StackChanFieldArguments,
  name: string
): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

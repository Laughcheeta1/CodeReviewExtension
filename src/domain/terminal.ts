
export function terminalPayload(
  path: string,
  text: string,
  ranges: readonly {
    start: number;
    end: number;
  }[],
): string {
  const source = text.split(/\r?\n/);
  const blocks = ranges.map((range) => {
    const last = range.end > range.start ? range.end - 1 : range.end;
    const firstOneBased = range.start + 1;
    const lastOneBased = Math.max(firstOneBased, last + 1);
    const label =
      firstOneBased === lastOneBased
        ? `${firstOneBased}`
        : `${firstOneBased} - ${lastOneBased}`;
    const content = source.slice(range.start, last + 1).join("\n");
    const backticks = Math.max(
      3,
      ...(content.match(/`+/g) ?? []).map((run) => run.length + 1),
    );
    const fence = "`".repeat(backticks);
    return `> Line ${label}, file ${path}:\n${fence}\n${content}\n${fence}\n`;
  });
  return `${blocks.join("\n")}\n`;
}


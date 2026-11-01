const split = /^split\((\d+)\)$/;
const shape = (steps: readonly string[]) => steps.map(step => step.replace(split, 'split')).join('/');

/**
 * The keys a check of kernel solid orders resolves: every key `listed`, and each formed from one by changing the indices of any of its
 * split steps, each to any index up to one past the most any listed key gives a split step after the same kinds of steps. Those are the
 * keys another solid order could have listed, and keys no order lists, which must resolve as missing in every order.
 */
export function cadBodyKeyVariants(listed: Iterable<string>): string[] {
  const keys = [...new Set(listed)], most = new Map<string, number>();
  for (const key of keys) {
    const steps = key.split('/');
    steps.forEach((step, place) => {
      const index = split.exec(step)?.[1];
      if (index !== undefined) most.set(shape(steps.slice(0, place)), Math.max(most.get(shape(steps.slice(0, place))) ?? 0, Number(index)));
    });
  }
  const formed = new Set<string>();
  for (const key of keys) {
    let variants = [[key.split('/')[0]]];
    for (const step of key.split('/').slice(1))
      variants = variants.flatMap(steps => split.test(step)
        ? Array.from({ length: (most.get(shape(steps)) ?? 1) + 2 }, (_, k) => [...steps, `split(${k})`])
        : [[...steps, step]]);
    for (const steps of variants) formed.add(steps.join('/'));
  }
  return [...formed];
}

// 占用关系的通用小工具：并查集与环检测。
// 计划分组与席位依赖都用「谁需要谁先释放」这层关系，但只有成环的两项
// 才必须整组一起提交；单向依赖只需按先后顺序办理。

export function makeUnionFind(nodes) {
  const parent = new Map(nodes.map(node => [node, node]))
  const find = (node) => {
    let current = node
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)))
      current = parent.get(current)
    }
    return current
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(a, b)
  }
  const components = (list = [...parent.keys()]) => {
    const map = new Map()
    for (const node of list) {
      const root = find(node)
      map.set(root, [...(map.get(root) ?? []), node])
    }
    return [...map.values()]
  }
  return { parent, find, union, components }
}

// 有向图上是否存在环（只看 allowed 内的节点）。
export function hasCycle(nodes, edges) {
  const allowed = new Set(nodes)
  const state = new Map()
  const visit = (node) => {
    if (state.get(node) === 'visiting') return true
    if (state.get(node) === 'done') return false
    state.set(node, 'visiting')
    for (const next of edges.get(node) ?? []) {
      if (!allowed.has(next)) continue
      if (visit(next)) return true
    }
    state.set(node, 'done')
    return false
  }
  return nodes.some(node => state.get(node) !== 'done' && visit(node))
}

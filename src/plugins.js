const HOOK_NAMES = Object.freeze([
  "setup",
  "onAction",
  "onEvent",
  "beforeTick",
  "afterTick",
  "dispose"
]);

function normalizePlugin(plugin, index = 0) {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError(`Plug-in at index ${index} must be an object.`);
  }

  if (typeof plugin.id !== "string" || plugin.id.trim() === "") {
    throw new TypeError(`Plug-in at index ${index} requires a non-empty id.`);
  }

  if (
    plugin.version !== undefined &&
    (typeof plugin.version !== "string" || plugin.version.trim() === "")
  ) {
    throw new TypeError(`Plug-in "${plugin.id}" has an invalid version.`);
  }

  const dependsOn = plugin.dependsOn ?? [];
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.some((dependency) => typeof dependency !== "string" || dependency.trim() === "")
  ) {
    throw new TypeError(`Plug-in "${plugin.id}" has invalid dependencies.`);
  }

  for (const hook of HOOK_NAMES) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
      throw new TypeError(`Plug-in "${plugin.id}" hook "${hook}" must be a function.`);
    }
  }

  return Object.freeze({
    ...plugin,
    id: plugin.id.trim(),
    version: plugin.version?.trim() ?? "0.0.0",
    dependsOn: Object.freeze([...new Set(dependsOn.map((value) => value.trim()))])
  });
}

function resolveOrder(plugins) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(plugin) {
    if (visited.has(plugin.id)) return;
    if (visiting.has(plugin.id)) {
      throw new Error(`Cyclic plug-in dependency detected at "${plugin.id}".`);
    }

    visiting.add(plugin.id);
    for (const dependencyId of plugin.dependsOn) {
      const dependency = plugins.get(dependencyId);
      if (!dependency) {
        throw new Error(
          `Plug-in "${plugin.id}" requires missing dependency "${dependencyId}".`
        );
      }
      visit(dependency);
    }
    visiting.delete(plugin.id);
    visited.add(plugin.id);
    ordered.push(plugin);
  }

  for (const plugin of plugins.values()) {
    visit(plugin);
  }

  return ordered;
}

function toMetadata(plugin) {
  return Object.freeze({
    id: plugin.id,
    version: plugin.version,
    dependsOn: Object.freeze([...plugin.dependsOn]),
    hooks: Object.freeze(HOOK_NAMES.filter((hook) => typeof plugin[hook] === "function"))
  });
}

export function createPluginRegistry(initialPlugins = []) {
  if (!Array.isArray(initialPlugins)) {
    throw new TypeError("Pulse Engine plug-ins must be provided as an array.");
  }

  let plugins = new Map();
  initialPlugins.forEach((input, index) => {
    const plugin = normalizePlugin(input, index);
    if (plugins.has(plugin.id)) {
      throw new Error(`Duplicate plug-in id "${plugin.id}".`);
    }
    plugins.set(plugin.id, plugin);
  });
  resolveOrder(plugins);

  function register(input) {
    const plugin = normalizePlugin(input, plugins.size);
    if (plugins.has(plugin.id)) {
      throw new Error(`Duplicate plug-in id "${plugin.id}".`);
    }

    const candidate = new Map(plugins);
    candidate.set(plugin.id, plugin);
    resolveOrder(candidate);
    plugins = candidate;
    return toMetadata(plugin);
  }

  function remove(id) {
    const plugin = plugins.get(id);
    if (!plugin) return null;

    const dependent = [...plugins.values()].find((item) => item.dependsOn.includes(id));
    if (dependent) {
      throw new Error(`Cannot remove "${id}" while "${dependent.id}" depends on it.`);
    }

    const candidate = new Map(plugins);
    candidate.delete(id);
    plugins = candidate;
    return plugin;
  }

  function ordered() {
    return Object.freeze([...resolveOrder(plugins)]);
  }

  function list() {
    return Object.freeze(ordered().map(toMetadata));
  }

  return Object.freeze({ list, ordered, register, remove });
}

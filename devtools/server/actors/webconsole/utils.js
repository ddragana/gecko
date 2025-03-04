/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft= javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Ci, Cu} = require("chrome");

// Note that this is only used in WebConsoleCommands, see $0 and pprint().
if (!isWorker) {
  loader.lazyImporter(this, "VariablesView", "resource://devtools/client/shared/widgets/VariablesView.jsm");
}

const CONSOLE_WORKER_IDS = exports.CONSOLE_WORKER_IDS = [
  "SharedWorker",
  "ServiceWorker",
  "Worker"
];

var WebConsoleUtils = {

  /**
   * Given a message, return one of CONSOLE_WORKER_IDS if it matches
   * one of those.
   *
   * @return string
   */
  getWorkerType: function(message) {
    const id = message ? message.innerID : null;
    return CONSOLE_WORKER_IDS[CONSOLE_WORKER_IDS.indexOf(id)] || null;
  },

  /**
   * Clone an object.
   *
   * @param object object
   *        The object you want cloned.
   * @param boolean recursive
   *        Tells if you want to dig deeper into the object, to clone
   *        recursively.
   * @param function [filter]
   *        Optional, filter function, called for every property. Three
   *        arguments are passed: key, value and object. Return true if the
   *        property should be added to the cloned object. Return false to skip
   *        the property.
   * @return object
   *         The cloned object.
   */
  cloneObject: function(object, recursive, filter) {
    if (typeof object != "object") {
      return object;
    }

    let temp;

    if (Array.isArray(object)) {
      temp = [];
      Array.forEach(object, function(value, index) {
        if (!filter || filter(index, value, object)) {
          temp.push(recursive ? WebConsoleUtils.cloneObject(value) : value);
        }
      });
    } else {
      temp = {};
      for (const key in object) {
        const value = object[key];
        if (object.hasOwnProperty(key) &&
            (!filter || filter(key, value, object))) {
          temp[key] = recursive ? WebConsoleUtils.cloneObject(value) : value;
        }
      }
    }

    return temp;
  },

  /**
   * Gets the ID of the inner window of this DOM window.
   *
   * @param nsIDOMWindow window
   * @return integer
   *         Inner ID for the given window.
   */
  getInnerWindowId: function(window) {
    return window.QueryInterface(Ci.nsIInterfaceRequestor)
             .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;
  },

  /**
   * Recursively gather a list of inner window ids given a
   * top level window.
   *
   * @param nsIDOMWindow window
   * @return Array
   *         list of inner window ids.
   */
  getInnerWindowIDsForFrames: function(window) {
    const innerWindowID = this.getInnerWindowId(window);
    let ids = [innerWindowID];

    if (window.frames) {
      for (let i = 0; i < window.frames.length; i++) {
        const frame = window.frames[i];
        ids = ids.concat(this.getInnerWindowIDsForFrames(frame));
      }
    }

    return ids;
  },

  /**
   * Get the property descriptor for the given object.
   *
   * @param object object
   *        The object that contains the property.
   * @param string prop
   *        The property you want to get the descriptor for.
   * @return object
   *         Property descriptor.
   */
  getPropertyDescriptor: function(object, prop) {
    let desc = null;
    while (object) {
      try {
        if ((desc = Object.getOwnPropertyDescriptor(object, prop))) {
          break;
        }
      } catch (ex) {
        // Native getters throw here. See bug 520882.
        // null throws TypeError.
        if (ex.name != "NS_ERROR_XPC_BAD_CONVERT_JS" &&
            ex.name != "NS_ERROR_XPC_BAD_OP_ON_WN_PROTO" &&
            ex.name != "TypeError") {
          throw ex;
        }
      }

      try {
        object = Object.getPrototypeOf(object);
      } catch (ex) {
        if (ex.name == "TypeError") {
          return desc;
        }
        throw ex;
      }
    }
    return desc;
  },

  /**
   * Create a grip for the given value. If the value is an object,
   * an object wrapper will be created.
   *
   * @param mixed value
   *        The value you want to create a grip for, before sending it to the
   *        client.
   * @param function objectWrapper
   *        If the value is an object then the objectWrapper function is
   *        invoked to give us an object grip. See this.getObjectGrip().
   * @return mixed
   *         The value grip.
   */
  createValueGrip: function(value, objectWrapper) {
    switch (typeof value) {
      case "boolean":
        return value;
      case "string":
        return objectWrapper(value);
      case "number":
        if (value === Infinity) {
          return { type: "Infinity" };
        } else if (value === -Infinity) {
          return { type: "-Infinity" };
        } else if (Number.isNaN(value)) {
          return { type: "NaN" };
        } else if (!value && 1 / value === -Infinity) {
          return { type: "-0" };
        }
        return value;
      case "undefined":
        return { type: "undefined" };
      case "object":
        if (value === null) {
          return { type: "null" };
        }
        // Fall through.
      case "function":
        return objectWrapper(value);
      default:
        console.error("Failed to provide a grip for value of " + typeof value
                      + ": " + value);
        return null;
    }
  },
};

exports.WebConsoleUtils = WebConsoleUtils;

/**
 * WebConsole commands manager.
 *
 * Defines a set of functions /variables ("commands") that are available from
 * the Web Console but not from the web page.
 *
 */
var WebConsoleCommands = {
  _registeredCommands: new Map(),
  _originalCommands: new Map(),

  /**
   * @private
   * Reserved for built-in commands. To register a command from the code of an
   * add-on, see WebConsoleCommands.register instead.
   *
   * @see WebConsoleCommands.register
   */
  _registerOriginal: function(name, command) {
    this.register(name, command);
    this._originalCommands.set(name, this.getCommand(name));
  },

  /**
   * Register a new command.
   * @param {string} name The command name (exemple: "$")
   * @param {(function|object)} command The command to register.
   *  It can be a function so the command is a function (like "$()"),
   *  or it can also be a property descriptor to describe a getter / value (like
   *  "$0").
   *
   *  The command function or the command getter are passed a owner object as
   *  their first parameter (see the example below).
   *
   *  Note that setters don't work currently and "enumerable" and "configurable"
   *  are forced to true.
   *
   * @example
   *
   *   WebConsoleCommands.register("$", function JSTH_$(owner, selector)
   *   {
   *     return owner.window.document.querySelector(selector);
   *   });
   *
   *   WebConsoleCommands.register("$0", {
   *     get: function(owner) {
   *       return owner.makeDebuggeeValue(owner.selectedNode);
   *     }
   *   });
   */
  register: function(name, command) {
    this._registeredCommands.set(name, command);
  },

  /**
   * Unregister a command.
   *
   * If the command being unregister overrode a built-in command,
   * the latter is restored.
   *
   * @param {string} name The name of the command
   */
  unregister: function(name) {
    this._registeredCommands.delete(name);
    if (this._originalCommands.has(name)) {
      this.register(name, this._originalCommands.get(name));
    }
  },

  /**
   * Returns a command by its name.
   *
   * @param {string} name The name of the command.
   *
   * @return {(function|object)} The command.
   */
  getCommand: function(name) {
    return this._registeredCommands.get(name);
  },

  /**
   * Returns true if a command is registered with the given name.
   *
   * @param {string} name The name of the command.
   *
   * @return {boolean} True if the command is registered.
   */
  hasCommand: function(name) {
    return this._registeredCommands.has(name);
  },
};

exports.WebConsoleCommands = WebConsoleCommands;

/*
 * Built-in commands.
  *
  * A list of helper functions used by Firebug can be found here:
  *   http://getfirebug.com/wiki/index.php/Command_Line_API
 */

/**
 * Find a node by ID.
 *
 * @param string id
 *        The ID of the element you want.
 * @return Node or null
 *         The result of calling document.querySelector(selector).
 */
WebConsoleCommands._registerOriginal("$", function(owner, selector) {
  try {
    return owner.window.document.querySelector(selector);
  } catch (err) {
    // Throw an error like `err` but that belongs to `owner.window`.
    throw new owner.window.DOMException(err.message, err.name);
  }
});

/**
 * Find the nodes matching a CSS selector.
 *
 * @param string selector
 *        A string that is passed to window.document.querySelectorAll.
 * @return NodeList
 *         Returns the result of document.querySelectorAll(selector).
 */
WebConsoleCommands._registerOriginal("$$", function(owner, selector) {
  let nodes;
  try {
    nodes = owner.window.document.querySelectorAll(selector);
  } catch (err) {
    // Throw an error like `err` but that belongs to `owner.window`.
    throw new owner.window.DOMException(err.message, err.name);
  }

  // Calling owner.window.Array.from() doesn't work without accessing the
  // wrappedJSObject, so just loop through the results instead.
  const result = new owner.window.Array();
  for (let i = 0; i < nodes.length; i++) {
    result.push(nodes[i]);
  }
  return result;
});

/**
 * Returns the result of the last console input evaluation
 *
 * @return object|undefined
 * Returns last console evaluation or undefined
 */
WebConsoleCommands._registerOriginal("$_", {
  get: function(owner) {
    return owner.consoleActor.getLastConsoleInputEvaluation();
  }
});

/**
 * Runs an xPath query and returns all matched nodes.
 *
 * @param string xPath
 *        xPath search query to execute.
 * @param [optional] Node context
 *        Context to run the xPath query on. Uses window.document if not set.
 * @return array of Node
 */
WebConsoleCommands._registerOriginal("$x", function(owner, xPath, context) {
  const nodes = new owner.window.Array();

  // Not waiving Xrays, since we want the original Document.evaluate function,
  // instead of anything that's been redefined.
  const doc = owner.window.document;
  context = context || doc;

  const results = doc.evaluate(xPath, context, null,
                             owner.window.XPathResult.ANY_TYPE, null);
  let node;
  while ((node = results.iterateNext())) {
    nodes.push(node);
  }

  return nodes;
});

/**
 * Returns the currently selected object in the highlighter.
 *
 * @return Object representing the current selection in the
 *         Inspector, or null if no selection exists.
 */
WebConsoleCommands._registerOriginal("$0", {
  get: function(owner) {
    return owner.makeDebuggeeValue(owner.selectedNode);
  }
});

/**
 * Clears the output of the WebConsole.
 */
WebConsoleCommands._registerOriginal("clear", function(owner) {
  owner.helperResult = {
    type: "clearOutput",
  };
});

/**
 * Clears the input history of the WebConsole.
 */
WebConsoleCommands._registerOriginal("clearHistory", function(owner) {
  owner.helperResult = {
    type: "clearHistory",
  };
});

/**
 * Returns the result of Object.keys(object).
 *
 * @param object object
 *        Object to return the property names from.
 * @return array of strings
 */
WebConsoleCommands._registerOriginal("keys", function(owner, object) {
  // Need to waive Xrays so we can iterate functions and accessor properties
  return Cu.cloneInto(Object.keys(Cu.waiveXrays(object)), owner.window);
});

/**
 * Returns the values of all properties on object.
 *
 * @param object object
 *        Object to display the values from.
 * @return array of string
 */
WebConsoleCommands._registerOriginal("values", function(owner, object) {
  const values = [];
  // Need to waive Xrays so we can iterate functions and accessor properties
  const waived = Cu.waiveXrays(object);
  const names = Object.getOwnPropertyNames(waived);

  for (const name of names) {
    values.push(waived[name]);
  }

  return Cu.cloneInto(values, owner.window);
});

/**
 * Opens a help window in MDN.
 */
WebConsoleCommands._registerOriginal("help", function(owner) {
  owner.helperResult = { type: "help" };
});

/**
 * Change the JS evaluation scope.
 *
 * @param DOMElement|string|window window
 *        The window object to use for eval scope. This can be a string that
 *        is used to perform document.querySelector(), to find the iframe that
 *        you want to cd() to. A DOMElement can be given as well, the
 *        .contentWindow property is used. Lastly, you can directly pass
 *        a window object. If you call cd() with no arguments, the current
 *        eval scope is cleared back to its default (the top window).
 */
WebConsoleCommands._registerOriginal("cd", function(owner, window) {
  if (!window) {
    owner.consoleActor.evalWindow = null;
    owner.helperResult = { type: "cd" };
    return;
  }

  if (typeof window == "string") {
    window = owner.window.document.querySelector(window);
  }
  if (Element.isInstance(window) && window.contentWindow) {
    window = window.contentWindow;
  }
  if (!(window instanceof Ci.nsIDOMWindow)) {
    owner.helperResult = {
      type: "error",
      message: "cdFunctionInvalidArgument"
    };
    return;
  }

  owner.consoleActor.evalWindow = window;
  owner.helperResult = { type: "cd" };
});

/**
 * Inspects the passed object. This is done by opening the PropertyPanel.
 *
 * @param object object
 *        Object to inspect.
 */
WebConsoleCommands._registerOriginal("inspect", function(owner, object) {
  const dbgObj = owner.makeDebuggeeValue(object);
  const grip = owner.createValueGrip(dbgObj);
  owner.helperResult = {
    type: "inspectObject",
    input: owner.evalInput,
    object: grip,
  };
});

/**
 * Prints object to the output.
 *
 * @param object object
 *        Object to print to the output.
 * @return string
 */
WebConsoleCommands._registerOriginal("pprint", function(owner, object) {
  if (object === null || object === undefined || object === true ||
      object === false) {
    owner.helperResult = {
      type: "error",
      message: "helperFuncUnsupportedTypeError",
    };
    return null;
  }

  owner.helperResult = { rawOutput: true };

  if (typeof object == "function") {
    return object + "\n";
  }

  const output = [];

  const obj = object;
  for (const name in obj) {
    const desc = WebConsoleUtils.getPropertyDescriptor(obj, name) || {};
    if (desc.get || desc.set) {
      // TODO: Bug 842672 - toolkit/ imports modules from browser/.
      const getGrip = VariablesView.getGrip(desc.get);
      const setGrip = VariablesView.getGrip(desc.set);
      const getString = VariablesView.getString(getGrip);
      const setString = VariablesView.getString(setGrip);
      output.push(name + ":", "  get: " + getString, "  set: " + setString);
    } else {
      const valueGrip = VariablesView.getGrip(obj[name]);
      const valueString = VariablesView.getString(valueGrip);
      output.push(name + ": " + valueString);
    }
  }

  return "  " + output.join("\n  ");
});

/**
 * Print the String representation of a value to the output, as-is.
 *
 * @param any value
 *        A value you want to output as a string.
 * @return void
 */
WebConsoleCommands._registerOriginal("print", function(owner, value) {
  owner.helperResult = { rawOutput: true };
  if (typeof value === "symbol") {
    return Symbol.prototype.toString.call(value);
  }
  // Waiving Xrays here allows us to see a closer representation of the
  // underlying object. This may execute arbitrary content code, but that
  // code will run with content privileges, and the result will be rendered
  // inert by coercing it to a String.
  return String(Cu.waiveXrays(value));
});

/**
 * Copy the String representation of a value to the clipboard.
 *
 * @param any value
 *        A value you want to copy as a string.
 * @return void
 */
WebConsoleCommands._registerOriginal("copy", function(owner, value) {
  let payload;
  try {
    if (Element.isInstance(value)) {
      payload = value.outerHTML;
    } else if (typeof value == "string") {
      payload = value;
    } else {
      payload = JSON.stringify(value, null, "  ");
    }
  } catch (ex) {
    payload = "/* " + ex + " */";
  }
  owner.helperResult = {
    type: "copyValueToClipboard",
    value: payload,
  };
});

/**
 * (Internal only) Add the bindings to |owner.sandbox|.
 * This is intended to be used by the WebConsole actor only.
  *
  * @param object owner
  *        The owning object.
  */
function addWebConsoleCommands(owner) {
  // Not supporting extra commands in workers yet.  This should be possible to
  // add one by one as long as they don't require jsm, Cu, etc.
  const commands = isWorker ? [] : WebConsoleCommands._registeredCommands;
  if (!owner) {
    throw new Error("The owner is required");
  }
  for (const [name, command] of commands) {
    if (typeof command === "function") {
      owner.sandbox[name] = command.bind(undefined, owner);
    } else if (typeof command === "object") {
      const clone = Object.assign({}, command, {
        // We force the enumerability and the configurability (so the
        // WebConsoleActor can reconfigure the property).
        enumerable: true,
        configurable: true
      });

      if (typeof command.get === "function") {
        clone.get = command.get.bind(undefined, owner);
      }
      if (typeof command.set === "function") {
        clone.set = command.set.bind(undefined, owner);
      }

      Object.defineProperty(owner.sandbox, name, clone);
    }
  }
}

exports.addWebConsoleCommands = addWebConsoleCommands;

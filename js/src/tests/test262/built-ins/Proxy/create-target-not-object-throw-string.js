// Copyright (C) 2015 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
es6id: 9.5.15
description: >
    Proxy ( target, handler )
    ...
    1. If Type(target) is not Object, throw a TypeError exception.
    ...
---*/

assert.throws(TypeError, function() {
  new Proxy("", {});
});

reportCompare(0, 0);

// |reftest| skip-if(!this.hasOwnProperty('Atomics')) -- Atomics is not enabled unconditionally
// Copyright (C) 2018 Amal Hussein. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-atomics.wake
description: >
  Throws a TypeError if the typedArray arg is not a TypedArray object
info: |
  Atomics.wake( typedArray, index, count )

  1.Let buffer be ? ValidateSharedIntegerTypedArray(typedArray, true).
    ...
      3.If typedArray does not have a [[TypedArrayName]] internal slot, throw a TypeError exception.

features: [Atomics]
---*/

var poisoned = {
  valueOf: function() {
    throw new Test262Error("should not evaluate this code");
  }
};

assert.throws(TypeError, function() {
  Atomics.wait({}, 0, 0, 0);
});

assert.throws(TypeError, function () {
  Atomics.wait({}, poisoned, poisoned, poisoned);
});

reportCompare(0, 0);

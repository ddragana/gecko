// Copyright 2009 the Sputnik authors.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
info: |
    If B = 11110xxx (n = 4) and (string.charAt(k + 4) and
    string.charAt(k + 5)) or (string.charAt(k + 7) and
    string.charAt(k + 8)) or (string.charAt(k + 10) and
    string.charAt(k + 11)) do not represent hexadecimal digits, throw URIError
es5id: 15.1.3.2_A1.12_T1
es6id: 18.2.6.3
esid: sec-decodeuricomponent-encodeduricomponent
description: >
    Complex tests, string.charAt(k + 4) and string.charAt(k + 5)  do
    not represent hexadecimal digits
---*/

//CHECK
var result = true;
var interval = [
  [0x00, 0x29],
  [0x40, 0x40],
  [0x47, 0x60],
  [0x67, 0xFFFF]
];
for (var indexI = 0; indexI < interval.length; indexI++) {
  for (var indexJ = interval[indexI][0]; indexJ <= interval[indexI][1]; indexJ++) {
    try {
      decodeURIComponent("%F0%" + String.fromCharCode(indexJ, indexJ) + "%A0%A0");
      result = false;
    } catch (e) {
      if ((e instanceof URIError) !== true) {
        result = false;
      }
    }
  }
}

if (result !== true) {
  $ERROR('#1: If B = 11110xxx (n = 4) and (string.charAt(k + 4) and string.charAt(k + 5)) do not represent hexadecimal digits, throw URIError');
}

reportCompare(0, 0);

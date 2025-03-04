/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef jslibmath_h
#define jslibmath_h

#include "mozilla/FloatingPoint.h"

#include <math.h>

#include "js/Value.h"
#include "vm/JSContext.h"

namespace js {

inline double
NumberDiv(double a, double b)
{
    AutoUnsafeCallWithABI unsafe;
    if (b == 0) {
        if (a == 0 || mozilla::IsNaN(a))
            return JS::GenericNaN();
        if (mozilla::IsNegative(a) != mozilla::IsNegative(b))
            return mozilla::NegativeInfinity<double>();
        return mozilla::PositiveInfinity<double>();
    }

    return a / b;
}

inline double
NumberMod(double a, double b)
{
    AutoUnsafeCallWithABI unsafe;
    if (b == 0)
        return JS::GenericNaN();
    return fmod(a, b);
}

} // namespace js

#endif /* jslibmath_h */

// OpenCV 4.10's Emscripten glue creates binding wrappers from strings. Keep the
// bindings and argument counts, but use ordinary closures under strict CSP.
function craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc) {
  if (argTypes.length < 2) throwBindingError('argTypes array size mismatch!');
  const count = argTypes.length - 2;
  const method = argTypes[1] !== null && classType !== null;
  const needsStack = argTypes.slice(1).some((type) => type !== null && type.destructorFunction === undefined);
  const invoke = function (...values) {
    if (values.length !== count) throwBindingError('function ' + humanName + ' called with ' + values.length + ' arguments, expected ' + count + ' args!');
    const destructors = needsStack ? [] : null;
    const wired = [];
    if (method) wired.push(argTypes[1].toWireType(destructors, this));
    for (let i = 0; i < count; i++) wired.push(argTypes[i + 2].toWireType(destructors, values[i]));
    const result = cppInvokerFunc.apply(null, [cppTargetFunc, ...wired]);
    if (needsStack) runDestructors(destructors);
    else for (let i = method ? 1 : 2; i < argTypes.length; i++) {
      if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(wired[i - (method ? 1 : 2)]);
    }
    if (argTypes[0].name !== 'void') return argTypes[0].fromWireType(result);
  };
  Object.defineProperties(invoke, { name: { value: makeLegalFunctionName(humanName), configurable: true }, length: { value: count, configurable: true } });
  return invoke;
}

function __emval_get_method_caller(argCount, argTypes) {
  const types = __emval_lookupTypes(argCount, argTypes), retType = types[0];
  const invoke = function (handle, name, destructors, args) {
    const values = []; let offset = 0;
    for (let i = 1; i < types.length; i++) {
      values.push(types[i].readValueFromPointer(args + offset)); offset += types[i].argPackAdvance;
    }
    const result = handle[name].apply(handle, values);
    for (let i = 1; i < types.length; i++) if (types[i].deleteObject) types[i].deleteObject(values[i - 1]);
    if (!retType.isVoid) return retType.toWireType(destructors, result);
  };
  return __emval_addMethodCaller(invoke);
}

export function hardenOpenCv(source) {
  const patches = [
    [/function createNamedFunction\(name,body\)\{[\s\S]*?(?=function extendError\()/g,
      'function createNamedFunction(name,body){var fn=function(){"use strict";return body.apply(this,arguments)};Object.defineProperty(fn,"name",{value:makeLegalFunctionName(name),configurable:true});return fn}'],
    [/function makeDynCaller\(dynCall\)\{[\s\S]*?\}var fp;/g,
      'function makeDynCaller(dynCall){var count=signature.length-1;var fn=function(){var args=[rawFunction];for(var i=0;i<count;i++)args.push(arguments[i]);return dynCall.apply(null,args)};Object.defineProperties(fn,{name:{value:"dynCall_"+signature+"_"+rawFunction,configurable:true},length:{value:count,configurable:true}});return fn}var fp;'],
    [/function craftInvokerFunction\([\s\S]*?(?=function heap32VectorToArray\()/g, craftInvokerFunction.toString()],
    [/function __emval_get_method_caller\([\s\S]*?(?=function __emval_get_property\()/g, __emval_get_method_caller.toString()],
  ];
  for (const [pattern, replacement] of patches) {
    if ([...source.matchAll(pattern)].length !== 1) throw new Error('Unsupported OpenCV glue; review the CSP adaptation before upgrading');
    source = source.replace(pattern, replacement);
  }
  if (/\b(?:new\s+)?Function\s*\(|\beval\s*\(|\bnew_\(Function\b/.test(source)) throw new Error('Unexpected dynamic JavaScript in OpenCV glue');
  return source;
}

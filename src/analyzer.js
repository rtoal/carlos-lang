import fs from "fs"
import * as ohm from "ohm-js"
import * as core from "./core.js"
import * as stdlib from "./stdlib.js"

const grammar = ohm.grammar(fs.readFileSync("src/carlos.ohm"))

// This used a lot, so save typing
const Type = core.Type

function check(condition, message, node) {
  if (!condition) core.error(message, node)
}

function checkType(e, types, expectation) {
  check(types.includes(e.type), `Expected ${expectation}`)
}

function checkNumeric(e) {
  checkType(e, [Type.INT, Type.FLOAT], "a number")
}

function checkNumericOrString(e) {
  checkType(e, [Type.INT, Type.FLOAT, Type.STRING], "a number or string")
}

function checkBoolean(e) {
  checkType(e, [Type.BOOLEAN], "a boolean")
}

function checkInteger(e) {
  checkType(e, [Type.INT], "an integer")
}

function checkIsAType(e) {
  check(e instanceof Type, "Type expected")
}

function checkIsAnOptional(e) {
  check(e.type.constructor === core.OptionalType, "Optional expected")
}

function checkIsAStruct(e) {
  check(e.type.constructor === core.StructType, "Optional expected")
}

function checkIsAnOptionalStruct(e) {
  check(
    e.type.constructor === core.OptionalType &&
      e.type.baseType.constructor == core.StructType,
    "Optional expected",
    e
  )
}

function checkArray(e) {
  check(e.type.constructor === core.ArrayType, "Array expected")
}

function checkHaveSameType(e1, e2) {
  check(e1.type.isEquivalentTo(e2.type), "Operands do not have the same type")
}

function checkAllHaveSameType(expressions) {
  check(
    expressions.slice(1).every(e => e.type.isEquivalentTo(expressions[0].type)),
    "Not all elements have the same type"
  )
}

function checkNotRecursive(struct) {
  check(
    !struct.fields.map(f => f.type).includes(struct),
    "Struct type must not be recursive"
  )
}

function checkAssignable(e, { toType: type }) {
  check(
    type === Type.ANY || e.type.isAssignableTo(type),
    `Cannot assign a ${e.type.description} to a ${type.description}`
  )
}

function checkNotReadOnly(e) {
  check(!e.readOnly, `Cannot assign to constant ${e.name}`)
}

function checkFieldsAllDistinct(fields) {
  check(
    new Set(fields.map(f => f.name)).size === fields.length,
    "Fields must be distinct"
  )
}

function checkMemberDeclared(field, { in: structType }) {
  check(structType.fields.map(f => f.name).includes(field), "No such field")
}

function checkInLoop(context) {
  check(context.inLoop, "Break can only appear in a loop")
}

function checkInFunction(context) {
  check(context.function, "Return can only appear in a function")
}

function checkCallable(e) {
  check(
    e.constructor === core.StructType || e.type.constructor == core.FunctionType,
    "Call of non-function or non-constructor"
  )
}

function checkReturnsNothing(f) {
  check(f.type.returnType === Type.VOID, "Something should be returned here")
}

function checkReturnsSomething(f) {
  check(f.type.returnType !== Type.VOID, "Cannot return a value here")
}

function checkReturnable({ expression: e, from: f }) {
  checkAssignable(e, { toType: f.type.returnType })
}

function checkArgumentsMatch(args, targetTypes) {
  check(
    targetTypes.length === args.length,
    `${targetTypes.length} argument(s) required but ${args.length} passed`
  )
  targetTypes.forEach((type, i) => checkAssignable(args[i], { toType: type }))
}

function checkFunctionCallArguments(args, calleeType) {
  checkArgumentsMatch(args, calleeType.paramTypes)
}

function checkConstructorArguments(args, structType) {
  const fieldTypes = structType.fields.map(f => f.type)
  checkArgumentsMatch(args, fieldTypes)
}

class Context {
  constructor({ parent = null, locals = new Map(), inLoop = false, function: f = null }) {
    Object.assign(this, { parent, locals, inLoop, function: f })
  }
  sees(name) {
    // Search "outward" through enclosing scopes
    return this.locals.has(name) || this.parent?.sees(name)
  }
  add(name, entity) {
    // No shadowing! Prevent addition if id anywhere in scope chain! This is
    // a Carlos thing. Many other languages allow shadowing, and in these,
    // we would only have to check that name is not in this.locals
    if (this.sees(name)) core.error(`Identifier ${name} already declared`)
    this.locals.set(name, entity)
  }
  lookup(name) {
    const entity = this.locals.get(name)
    if (entity) {
      return entity
    } else if (this.parent) {
      return this.parent.lookup(name)
    }
    core.error(`Identifier ${name} not declared`)
  }
  newChildContext(props) {
    return new Context({ ...this, ...props, parent: this, locals: new Map() })
  }
}

export default function analyze(sourceCode) {
  let context = new Context({})

  const analyzer = grammar.createSemantics().addOperation("rep", {
    Program(body) {
      return new core.Program(body.rep())
    },

    VarDecl(modifier, id, _eq, initializer, _semicolon) {
      const e = initializer.rep()
      const readOnly = modifier.sourceString === "const"
      const v = new core.Variable(id.sourceString, readOnly, e.type)
      context.add(id.sourceString, v)
      return new core.VariableDeclaration(v, e)
    },

    TypeDecl(_struct, id, _left, fields, _right) {
      // To allow recursion, enter into context without any fields yet
      const type = new core.StructType(id.sourceString, [])
      context.add(id.sourceString, type)
      // Now add the types as you parse and analyze
      type.fields = fields.rep()
      checkFieldsAllDistinct(type.fields)
      checkNotRecursive(type)
      return new core.TypeDeclaration(type)
    },

    Field(id, _colon, type) {
      return new core.Field(id.rep(), type.rep())
    },

    FunDecl(_fun, id, _open, params, _close, _colons, returnType, body) {
      const rt = returnType.rep()[0] ?? core.Type.VOID
      const paramReps = params.asIteration().rep()
      const paramTypes = paramReps.map(p => p.type)
      const f = new core.Function(id.sourceString, new core.FunctionType(paramTypes, rt))
      context.add(id.sourceString, f)
      context = context.newChildContext({ inLoop: false, function: f })
      for (const p of paramReps) context.add(p.name, p)
      const b = body.rep()
      context = context.parent
      return new core.FunctionDeclaration(id.sourceString, f, paramReps, b)
    },

    Param(id, _colon, type) {
      return new core.Parameter(id.sourceString, type.rep())
    },

    Type_optional(baseType, _questionMark) {
      return new core.OptionalType(baseType.rep())
    },

    Type_array(_left, baseType, _right) {
      return new core.ArrayType(baseType.rep())
    },

    Type_function(_left, inTypes, _right, _arrow, outType) {
      return new core.FunctionType(inTypes.asIteration().rep(), outType.rep())
    },

    Type_id(id) {
      const entity = context.lookup(id.sourceString)
      checkIsAType(entity)
      return entity
    },

    Statement_bump(variable, operator, _semicolon) {
      const v = variable.rep()
      checkInteger(v)
      return operator.sourceString === "++"
        ? new core.Increment(v)
        : new core.Decrement(v)
    },

    Statement_assign(variable, _eq, expression, _semicolon) {
      const e = expression.rep()
      const v = variable.rep()
      checkAssignable(e, { toType: v.type })
      checkNotReadOnly(v)
      return new core.Assignment(v, e)
    },

    Statement_call(call, _semicolon) {
      return call.rep()
    },

    Statement_break(_break, _semicolon) {
      checkInLoop(context)
      return new core.BreakStatement()
    },

    Statement_return(_return, expression, _semicolon) {
      checkInFunction(context)
      checkReturnsSomething(context.function)
      const e = expression.rep()
      checkReturnable({ expression: e, from: context.function })
      return new core.ReturnStatement(e)
    },

    Statement_shortreturn(_return, _semicolon) {
      checkInFunction(context)
      checkReturnsNothing(context.function)
      return new core.ShortReturnStatement()
    },

    IfStmt_long(_if, test, consequent, _else, alternate) {
      const testRep = test.rep()
      checkBoolean(testRep)
      context = context.newChildContext()
      const consequentRep = consequent.rep()
      context = context.parent
      let alternateRep
      if (alternate.constructor === Array) {
        // It's a block of statements, make a new context
        context = context.newChildContext()
        alternateRep = alternate.rep()
        context = context.parent
      } else {
        // It's a trailing if-statement, so same context
        alternateRep = alternate.rep()
      }
      return new core.IfStatement(testRep, consequentRep, alternateRep)
    },

    IfStmt_short(_if, test, consequent) {
      const testRep = test.rep()
      checkBoolean(testRep)
      context = context.newChildContext()
      const consequentRep = consequent.rep()
      context = context.parent
      return new core.ShortIfStatement(testRep, consequentRep)
    },

    LoopStmt_while(_while, test, body) {
      const t = test.rep()
      checkBoolean(t)
      context = context.newChildContext({ inLoop: true })
      const b = body.rep()
      context = context.parent
      return new core.WhileStatement(t, b)
    },

    LoopStmt_repeat(_repeat, count, body) {
      const c = count.rep()
      checkInteger(c)
      context = context.newChildContext({ inLoop: true })
      const b = body.rep()
      context = context.parent
      return new core.RepeatStatement(c, b)
    },

    LoopStmt_range(_for, id, _in, low, op, high, body) {
      const [x, y] = [low.rep(), high.rep()]
      checkInteger(x)
      checkInteger(y)
      const iterator = new core.Variable(id.sourceString, Type.INT, true)
      context = context.newChildContext({ inLoop: true })
      context.add(id.sourceString, iterator)
      const b = body.rep()
      context = context.parent
      return new core.ForRangeStatement(iterator, x, op.rep(), y, b)
    },

    LoopStmt_collection(_for, id, _in, collection, body) {
      const c = collection.rep()
      checkArray(c)
      const i = new core.Variable(id.sourceString, true, c.type.baseType)
      context = context.newChildContext({ inLoop: true })
      context.add(i.name, i)
      const b = body.rep()
      context = context.parent
      return new core.ForStatement(i, c, b)
    },

    Block(_open, body, _close) {
      // No need for a block node, just return the list of statements
      return body.rep()
    },

    Exp_conditional(test, _questionMark, consequent, _colon, alternate) {
      const x = test.rep()
      checkBoolean(x)
      const [y, z] = [consequent.rep(), alternate.rep()]
      checkHaveSameType(y, z)
      return new core.Conditional(x, y, z)
    },

    Exp1_unwrapelse(unwrap, op, alternate) {
      const [x, o, y] = [unwrap.rep(), op.sourceString, alternate.rep()]
      checkIsAnOptional(x)
      checkAssignable(y, { toType: x.type.baseType })
      return new core.BinaryExpression(o, x, y, x.type)
    },

    Exp2_or(left, ops, right) {
      let [x, o, ys] = [left.rep(), ops.rep()[0], right.rep()]
      checkBoolean(x)
      for (let y of ys) {
        checkBoolean(y)
        x = new core.BinaryExpression(o, x, y, Type.BOOLEAN)
      }
      return x
    },

    Exp2_and(left, ops, right) {
      let [x, o, ys] = [left.rep(), ops.rep()[0], right.rep()]
      checkBoolean(x)
      for (let y of ys) {
        checkBoolean(y)
        x = new core.BinaryExpression(o, x, y, Type.BOOLEAN)
      }
      return x
    },

    Exp3_bitor(left, ops, right) {
      let [x, o, ys] = [left.rep(), ops.rep()[0], right.rep()]
      checkInteger(x)
      for (let y of ys) {
        checkInteger(y)
        x = new core.BinaryExpression(o, x, y, Type.INT)
      }
      return x
    },

    Exp3_bitxor(left, ops, right) {
      let [x, o, ys] = [left.rep(), ops.rep()[0], right.rep()]
      checkInteger(x)
      for (let y of ys) {
        checkInteger(y)
        x = new core.BinaryExpression(o, x, y, Type.INT)
      }
      return x
    },

    Exp3_bitand(left, ops, right) {
      let [x, o, ys] = [left.rep(), ops.rep()[0], right.rep()]
      checkInteger(x)
      for (let y of ys) {
        checkInteger(y)
        x = new core.BinaryExpression(o, x, y, Type.INT)
      }
      return x
    },

    Exp4_compare(left, op, right) {
      const [x, o, y] = [left.rep(), op.sourceString, right.rep()]
      if (["<", "<=", ">", ">="].includes(op.sourceString)) checkNumericOrString(x)
      checkHaveSameType(x, y)
      return new core.BinaryExpression(o, x, y, Type.BOOLEAN)
    },

    Exp5_shift(left, op, right) {
      const [x, o, y] = [left.rep(), op.rep(), right.rep()]
      checkInteger(x)
      checkInteger(y)
      return new core.BinaryExpression(o, x, y, Type.INT)
    },

    Exp6_add(left, op, right) {
      const [x, o, y] = [left.rep(), op.sourceString, right.rep()]
      if (o === "+") {
        checkNumericOrString(x)
      } else {
        checkNumeric(x)
      }
      checkHaveSameType(x, y)
      return new core.BinaryExpression(o, x, y, x.type)
    },

    Exp7_multiply(left, op, right) {
      const [x, o, y] = [left.rep(), op.sourceString, right.rep()]
      checkNumeric(x)
      checkHaveSameType(x, y)
      return new core.BinaryExpression(o, x, y, x.type)
    },

    Exp8_power(left, op, right) {
      const [x, o, y] = [left.rep(), op.sourceString, right.rep()]
      checkNumeric(x)
      checkHaveSameType(x, y)
      return new core.BinaryExpression(o, x, y, x.type)
    },

    Exp8_unary(op, operand) {
      const [o, x] = [op.sourceString, operand.rep()]
      let type
      if (o === "#") checkArray(x), (type = Type.INT)
      else if (o === "-") checkNumeric(x), (type = x.type)
      else if (o === "!") checkBoolean(x), (type = Type.BOOLEAN)
      else if (o === "some") type = new core.OptionalType(x.type)
      return new core.UnaryExpression(o, x, type)
    },

    Exp9_emptyarray(_keyword, _left, _of, type, _right) {
      return new core.EmptyArray(type.rep())
    },

    Exp9_arrayexp(_left, args, _right) {
      const elements = args.asIteration().rep()
      checkAllHaveSameType(elements)
      return new core.ArrayExpression(elements)
    },

    Exp9_emptyopt(_no, type) {
      return new core.EmptyOptional(type.rep())
    },

    Exp9_parens(_open, expression, _close) {
      return expression.rep()
    },

    Exp9_subscript(array, _left, subscript, _right) {
      const [a, i] = [array.rep(), subscript.rep()]
      checkArray(a)
      checkInteger(i)
      return new core.SubscriptExpression(a, i)
    },

    Exp9_member(object, dot, field) {
      const x = object.rep()
      const isOptional = dot.sourceString === "?."
      let structType
      if (isOptional) {
        checkIsAnOptionalStruct(x)
        structType = x.type.baseType
      } else {
        checkIsAStruct(x)
        structType = x.type
      }
      checkMemberDeclared(field.sourceString, { in: structType })
      const f = structType.fields.find(f => f.name === field.sourceString)
      return new core.MemberExpression(x, f, isOptional)
    },

    Exp9_call(callee, _left, args, _right) {
      const [c, a] = [callee.rep(), args.asIteration().rep()]
      checkCallable(c)
      let callType
      if (c.constructor === core.StructType) {
        checkConstructorArguments(a, c)
        callType = c
      } else {
        checkFunctionCallArguments(a, c.type)
        callType = c.type.returnType
      }
      return new core.Call(c, a, callType)
    },

    Exp9_id(_id) {
      return context.lookup(this.sourceString)
    },

    id(_first, _rest) {
      return this.sourceString
    },

    true(_) {
      return true
    },

    false(_) {
      return false
    },

    intlit(_digits) {
      return BigInt(this.sourceString)
    },

    floatlit(_whole, _point, _fraction, _e, _sign, _exponent) {
      return Number(this.sourceString)
    },

    stringlit(_openQuote, _chars, _closeQuote) {
      return this.sourceString
    },

    _terminal() {
      return this.sourceString
    },

    _iter(...children) {
      return children.map(child => child.rep())
    },
  })

  // Analysis starts here
  for (const [name, type] of Object.entries(stdlib.contents)) {
    context.add(name, type)
  }
  const match = grammar.match(sourceCode)
  if (!match.succeeded()) core.error(match.message)
  return analyzer(match).rep()
}

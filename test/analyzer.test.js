import assert from "assert"
import parse from "../src/parser.js"
import analyze from "../src/analyzer.js"

const semanticChecks = [
  ["variable declarations", 'const x = 1; let y = "false";'],
  ["complex array types", "function f(x: [[[int?]]?]) {}"],
  ["increment and decrement", "let x = 10; x--; x++;"],
  ["initialize with empty array", "let a = [](of int);"],
  ["struct declaration", "struct S {f: (int)->boolean? g: string}"],
  ["assign arrays", "let a = [](of int);let b=[1];a=b;b=a;"],
  ["initialize with empty optional", "let a = no int;"],
  ["short return", "function f() { return; }"],
  ["long return", "function f(): boolean { return true; }"],
  ["assign optionals", "let a = no int;let b=some 1;a=b;b=a;"],
  ["return in nested if", "function f() {if true {return;}}"],
  ["break in nested if", "while false {if true {break;}}"],
  ["long if", "if true {print(1);} else {print(3);}"],
  ["else if", "if true {print(1);} else if true {print(0);} else {print(3);}"],
  ["for over collection", "for i in [2,3,5] {print(1);}"],
  ["for in range", "for i in 1..<10 {print(0);}"],
  ["repeat", "repeat 3 {let a = 1; print(a);}"],
  ["conditionals with ints", "print(true ? 8 : 5);"],
  ["conditionals with floats", "print(1<2 ? 8.0 : -5.22);"],
  ["conditionals with strings", 'print(1<2 ? "x" : "y");'],
  ["??", "print(some 5 ?? 0);"],
  ["nested ??", "print(some 5 ?? 8 ?? 0);"],
  ["||", "print(true||1<2||false||!true);"],
  ["&&", "print(true&&1<2&&false&&!true);"],
  ["bit ops", "print((1&2)|(9^3));"],
  ["relations", 'print(1<=2 && "x">"y" && 3.5<1.2);'],
  // ["ok to == arrays", "print([1]==[5,8]);"],
  // ["ok to != arrays", "print([1]!=[5,8]);"],
  ["shifts", "print(1<<3<<5<<8>>2>>0);"],
  ["arithmetic", "let x=1;print(2*3+5**-3/2-5%8);"],
  ["optional types", "let x = no int; x = some 100;"],
  ["variables", "let x=[[[[1]]]]; print(x[0][0][0][0]+2);"],
  // ["nested structs", "struct S {z: S?} let x = S(no S);"],
  ["array length", "print(#[1,2,3]);"],
  ["assigned functions", "function f() {}\nlet g = f;g = f;"],
  ["call of assigned functions", "function f(x: int) {}\nlet g=f;g(1);"],
  [
    "call of assigned function in expression",
    `function f(x: int, y: boolean): int {}
    let g = f;
    print(g(1, true));
    f = g; // Type check here`,
  ],
  [
    "pass a function to a function",
    `function f(x: int, y: (boolean)->void): int { return 1; }
     function g(z: boolean) {}
     f(2, g);`,
  ],
  [
    "function return types",
    `function square(x: int): int { return x * x; }
     function compose(): (int)->int { return square; }`,
  ],
  ["struct parameters", "struct S {} function f(x: S) {}"],
  ["array parameters", "function f(x: [int?]) {}"],
  ["optional parameters", "function f(x: [int], y: string?) {}"],
  ["member exp", "struct S {x: int} let y = S(1);print(y.x);"],
  ["subscript exp", "let a=[1,2];print(a[0]);"],
  ["built-in constants", "print(25.0 * π);"],
  ["built-in sin", "print(sin(π));"],
  ["built-in cos", "print(cos(93.999));"],
  ["built-in hypot", "print(hypot(-4.0, 3.00001));"],
]

const semanticErrors = [
  ["non-distinct fields", "struct S {x: boolean x: int}", /Fields must be distinct/],
  ["non-int increment", "let x=false;x++;", /an integer, found boolean/],
  ["non-int decrement", 'let x=some[""];x++;', /an integer, found [string]?/],
  ["undeclared id", "print(x);", /Identifier x not declared/],
  ["redeclared id", "let x = 1;let x = 1;", /Identifier x already declared/],
  ["assign to const", "const x = 1;x = 2;", /Cannot assign to constant x/],
  ["assign bad type", "let x=1;x=true;", /Cannot assign a boolean to a int/],
  ["assign bad array type", "let x=1;x=[true];", /Cannot assign a \[boolean\] to a int/],
  ["assign bad optional type", "let x=1;x=some 2;", /Cannot assign a int\? to a int/],
  ["break outside loop", "break;", /Break can only appear in a loop/],
  [
    "break inside function",
    "while true {function f() {break;}}",
    /Break can only appear in a loop/,
  ],
  ["return outside function", "return;", /Return can only appear in a function/],
  [
    "return value from void function",
    "function f() {return 1;}",
    /Cannot return a value here/,
  ],
  [
    "return nothing from non-void",
    "function f(): int {return;}",
    /should be returned here/,
  ],
  ["return type mismatch", "function f(): int {return false;}", /boolean to a int/],
  ["non-boolean short if test", "if 1 {}", /a boolean, found int/],
  ["non-boolean if test", "if 1 {} else {}", /a boolean, found int/],
  ["non-boolean while test", "while 1 {}", /a boolean, found int/],
  ["non-integer repeat", 'repeat "1" {}', /an integer, found string/],
  ["non-integer low range", "for i in true...2 {}", /an integer, found boolean/],
  ["non-integer high range", "for i in 1..<no int {}", /an integer, found int\?/],
  ["non-array in for", "for i in 100 {}", /Array expected/],
  ["non-boolean conditional test", "print(1?2:3);", /a boolean, found int/],
  ["diff types in conditional arms", "print(true?1:true);", /not have the same type/],
  ["unwrap non-optional", "print(1??2);", /Optional expected/],
  ["bad types for ||", "print(false||1);", /a boolean, found int/],
  ["bad types for &&", "print(false&&1);", /a boolean, found int/],
  ["bad types for ==", "print(false==1);", /Operands do not have the same type/],
  ["bad types for !=", "print(false==1);", /Operands do not have the same type/],
  ["bad types for +", "print(false+1);", /number or string, found boolean/],
  ["bad types for -", "print(false-1);", /a number, found boolean/],
  ["bad types for *", "print(false*1);", /a number, found boolean/],
  ["bad types for /", "print(false/1);", /a number, found boolean/],
  ["bad types for **", "print(false**1);", /a number, found boolean/],
  ["bad types for <", "print(false<1);", /number or string, found boolean/],
  ["bad types for <=", "print(false<=1);", /number or string, found bool/],
  ["bad types for >", "print(false>1);", /number or string, found bool/],
  ["bad types for >=", "print(false>=1);", /number or string, found bool/],
  ["bad types for ==", "print(2==2.0);", /not have the same type/],
  ["bad types for !=", "print(false!=1);", /not have the same type/],
  ["bad types for negation", "print(-true);", /a number, found boolean/],
  ["bad types for length", "print(#false);", /Array expected/],
  ["bad types for not", 'print(!"hello");', /a boolean, found string/],
  ["shadowing", "let x = 1;\nwhile true {let x = 1;}", /Identifier x already declared/],
  [
    "Too many args",
    "function f(x: int) {}\nf(1,2);",
    /1 argument\(s\) required but 2 passed/,
  ],
  [
    "Too few args",
    "function f(x: int) {}\nf();",
    /1 argument\(s\) required but 0 passed/,
  ],
  [
    "Parameter type mismatch",
    "function f(x: int) {}\nf(false);",
    /Cannot assign a boolean to a int/,
  ],
  ["call of non-function", "let x = 1;\nprint(x());", /Call of non-function/],
  [
    "function type mismatch",
    `function f(x: int, y: (boolean)->void): int { return 1; }
     function g(z: boolean): int { return 5; }
     f(2, g);`,
    /Cannot assign a \(boolean\)->int to a \(boolean\)->void/,
  ],
  [
    "bad call to a standard library function",
    "print(sin(true));",
    /Cannot assign a boolean to a float/,
  ],
]

describe("The analyzer", () => {
  for (const [scenario, source] of semanticChecks) {
    it(`recognizes ${scenario}`, () => {
      assert.ok(analyze(parse(source)))
    })
  }
  for (const [scenario, source, errorMessagePattern] of semanticErrors) {
    it(`throws on ${scenario}`, () => {
      assert.throws(() => analyze(parse(source)), errorMessagePattern)
    })
  }
})

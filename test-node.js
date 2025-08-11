// Test Node.js file with an error
console.log("Starting test...");

function divide(a, b) {
    if (b === 0) {
        throw new Error("Division by zero!");
    }
    return a / b;
}

console.log("Result:", divide(10, 2));
console.log("This will cause an error:", divide(10, 0));
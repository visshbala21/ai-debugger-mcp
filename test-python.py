#!/usr/bin/env python3
# Test Python file with an error
print("Starting Python test...")

def divide(a, b):
    if b == 0:
        raise ValueError("Division by zero!")
    return a / b

print("Result:", divide(10, 2))
print("This will cause an error:", divide(10, 0))
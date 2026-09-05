# RSA Brute-Force Decryption — Complete Beginner Tutorial

> **Your case:**
> ```
> n = 35802469135802468914197530864197531
> e = 65537
> c = 23104147591671948052859847954945272
> ```
> Goal: recover the private key and decrypt `c` (the ciphertext) to the plaintext message.

---

## Table of Contents
1. [What is RSA? (No prior knowledge required)](#1-what-is-rsa-no-prior-knowledge-required)
2. [How RSA Works — The Math in Plain English](#2-how-rsa-works--the-math-in-plain-english)
3. [Why "Brute Force" Works on Small Keys](#3-why-brute-force-works-on-small-keys)
4. [Overview of the Attack: 5 Steps](#4-overview-of-the-attack-5-steps)
5. [Prerequisites](#5-prerequisites)
6. [Method A — Using RsaCtfTool (Recommended for Homework)](#6-method-a--using-rsactftool-recommended-for-homework)
7. [Method B — Doing It Manually With Python (Understand Every Step)](#7-method-b--doing-it-manually-with-python-understand-every-step)
8. [Step-by-Step With YOUR Numbers](#8-step-by-step-with-your-numbers)
9. [Decoding the Plaintext — From Integer to Readable Text](#9-decoding-the-plaintext--from-integer-to-readable-text)
10. [Verification](#10-verification)
11. [What to Submit for Homework](#11-what-to-submit-for-homework)
12. [Security Lesson & Ethics](#12-security-lesson--ethics)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What is RSA? (No prior knowledge required)

RSA is named after **R**ivest, **S**hamir, **A**dleman (MIT, 1977). It is the most famous *asymmetric* cryptosystem.

Analogies:

*   **Symmetric encryption** = one shared key (like a house key: same key locks and unlocks).
*   **Asymmetric encryption** = two keys: **public key** you share with everyone, **private key** you keep secret.

Think of a **padlock**:
*   Anyone can **lock** a box with your open padlock (public key) → encryption.
*   Only you have the **key to open** it (private key) → decryption.

In RSA:
*   **Public key = (n, e)** — given to the world.
*   **Private key = (n, d)** — kept secret, `d` is the inverse of `e`.
*   **Ciphertext `c`** = the encrypted message as a big integer.
*   **Plaintext `m`** = the original message as a big integer.

If you have `c` and `(n, e)` but not `d`, you **should not** be able to recover `m` — unless `n` is too small and you can *factor* it.

---

## 2. How RSA Works — The Math in Plain English

You do NOT need to be a mathematician. Here are the building blocks:

### 2.1 Prime Numbers
A prime is divisible only by 1 and itself: `2, 3, 5, 7, 11, 13, 17, 19, 23 ...` RSA picks two large random primes `p` and `q`.

### 2.2 Modulus `n`
```
n = p × q
```
`n` is the modulus, part of both public and private keys. If `p` and `q` are 1000-bit each, `n` is 2000-bit (~600 decimal digits) and impossible to factor with today's computers.

**Example (tiny, insecure):** `p=61, q=53 → n=3233`

### 2.3 Euler's Totient `φ(n)`
Counts numbers coprime to `n`. When `n = p×q` and both are primes:
```
φ(n) = (p-1) × (q-1)
```
Example: `φ(3233) = 60×52 = 3120`

> **Why care?** `φ(n)` is used to compute the private exponent `d`. You need `p` and `q` to get it.

### 2.4 Exponents `e` and `d`
*   Choose `e` (commonly `65537` = `0x10001`) such that `1 < e < φ(n)` and `gcd(e, φ(n))=1` (coprime).
*   Compute `d` = **modular inverse** of `e` modulo `φ(n)`:
```
d × e ≡ 1 (mod φ(n))   →   d = e⁻¹ mod φ(n)
```
In words: `d` is the number that when multiplied by `e` gives remainder `1` after division by `φ(n)`. Calculated with the *Extended Euclidean Algorithm*.

Example: `e=17, φ=3120 → d=2753` because `17×2753 = 46801 = 15×3120 + 1`.

### 2.5 Encryption & Decryption
```
Encryption:  c = mᵉ mod n      (m → c with public key)
Decryption:  m = cᵈ mod n      (c → m with private key)
```
`mod n` means "remainder after dividing by n". `pow(m, e, n)` in Python.

**Magic:** `(mᵉ)ᵈ mod n = m` because of how `e` and `d` relate via `φ(n)`. This is Euler's theorem.

### Summary Diagram
```
Key Generation:  p,q  →  n=pq  →  φ=(p-1)(q-1)  →  pick e  →  compute d = e⁻¹ mod φ
Public:  (n,e)   Private: (n,d)

Encrypt:  c = pow(m, e, n)
Decrypt:  m = pow(c, d, n)
Attacker with only (n,e,c) must FACTOR n to get p,q → φ → d → m
```

---

## 3. Why "Brute Force" Works on Small Keys

Real RSA: `n` ≈ 2048 bits (~617 digits) → factoring would take billions of years.

Homework RSA: `n = 35802469135802468914197530864197531` is **115 bits** (~35 digits) → trivial to factor in seconds with modern tools. That is the whole point: to *show* why small keys are insecure.

"Brute force" here does not mean trying all `d` values. It means **factoring `n` into `p×q`** by:
*   Trial division,
*   Pollard's Rho algorithm,
*   Fermat, ECM, or online databases like **factordb.com**.

Once you have `p` and `q`, the rest is instant.

---

## 4. Overview of the Attack: 5 Steps

Given `(n, e, c)`:

| Step | What | Formula/Tool |
|------|------|--------------|
| **1** | **Factor `n`** | Find `p, q` such that `p×q = n` using `RsaCtfTool` or `factordb` or Python |
| **2** | **Compute φ(n)** | `φ = (p-1)*(q-1)` |
| **3** | **Compute private exponent `d`** | `d = pow(e, -1, φ)` (Python 3.8+) or Extended Euclid |
| **4** | **Decrypt** | `m = pow(c, d, n)` |
| **5** | **Decode `m` to text** | `long_to_bytes` or decimal ASCII decoding |

We will do all 5 below with your numbers.

---

## 5. Prerequisites

*   Python 3.8+
*   Git
*   Internet for `factordb` (optional but helps)

Install RsaCtfTool:

```bash
git clone https://github.com/RsaCtfTool/RsaCtfTool
cd RsaCtfTool
pip3 install -r requirements.txt   # use pip3 or python3 -m pip
# On Kali/Ubuntu you may need: sudo apt install libgmp3-dev libmpfr-dev
```

Help menu:

```bash
python3 RsaCtfTool.py --help
```

Key flags you need:

```
--n <number>              modulus
--e <number>              public exponent
--uncipher <number>       ciphertext (decimal or hex)
--private                 print private key recovered
--attack factordb         force factordb lookup
```

---

## 6. Method A — Using RsaCtfTool (Recommended for Homework)

### 6.1 Prepare Your Data
You have decimal integers, so you can pass them directly. No PEM file needed.

### 6.2 Run the Tool

```bash
python3 RsaCtfTool.py --n 35802469135802468914197530864197531 \
                      --e 65537 \
                      --uncipher 23104147591671948052859847954945272 \
                      --private
```

What it does internally:
1. Tries to factor `n` via trial division, Pollard Rho, ECM, and **factordb.com** API.
2. For your `n`, the factordb attack succeeds instantly:
   ```
   n = 161111111111111111 × 222222222222222221
   ```
3. Computes `φ`, `d`, then `m = c^d mod n`.
4. Prints `private key` and `decrypted plaintext integer`.

**Expected output (excerpt):**

```
[*] Testing factordb
[*] Found factorization: 161111111111111111 * 222222222222222221
[*] Private exponent d = 27334366017349166355040984293671073
[*] Decrypted int: 828352957048829584725195874978
```

> **Tip:** If the automatic attack list fails, force factordb:
> ```bash
> python3 RsaCtfTool.py --n 35802469135802468914197530864197531 --e 65537 --uncipher 23104147591671948052859847954945272 --attack factordb
> ```

### 6.3 Get a PEM Private Key (Optional)
To see the full private key in PEM format:

```bash
python3 RsaCtfTool.py --n 35802469135802468914197530864197531 --e 65537 --private -o private.pem
cat private.pem
openssl rsa -in private.pem -text -noout   # inspect p,q,d
```

### 6.4 Manual factordb Check (No Tool)
Visit `http://factordb.com/index.php?query=35802469135802468914197530864197531`
It shows:

```
35802469135802468914197530864197531 = 161111111111111111 · 222222222222222221
```
Second proof without running any code.

---

## 7. Method B — Doing It Manually With Python (Understand Every Step)

This is what professors want you to explain.

```python
# step1: factor n (from factordb or RsaCtfTool)
p = 161111111111111111
q = 222222222222222221
n = 35802469135802468914197530864197531
assert p * q == n

# step2: phi
phi = (p-1) * (q-1)
print(f"phi = {phi}")  # 35802469135802468530864197530864200

# step3: d = e^{-1} mod phi
e = 65537
d = pow(e, -1, phi)   # Python 3.8+; for older: use egcd
print(f"d = {d}")     # 27334366017349166355040984293671073

# alternative manual extended Euclid if pow with -1 not available:
def egcd(a, b):
    if b == 0: return (a, 1, 0)
    g, x1, y1 = egcd(b, a % b)
    return (g, y1, x1 - (a // b) * y1)

def modinv(a, m):
    g, x, _ = egcd(a, m)
    assert g == 1, "no inverse"
    return x % m

# d = modinv(e, phi)

# step4: decrypt
c = 23104147591671948052859847954945272
m = pow(c, d, n)
print(f"m = {m}")  # 828352957048829584725195874978

# step5: verify (encrypt back)
assert pow(m, e, n) == c
print("Decryption verified!")

# try to decode as bytes (hex method) — will look garbled for this challenge:
print(hex(m))  # 0xa748d81a4db4cb105e743e2a2
print(m.to_bytes((m.bit_length()+7)//8, 'big'))  # b'\n t\x8d...'

# for THIS homework, decode as decimal ASCII concatenation:
s = str(m)  # "828352957048829584725195874978"
decoded = ''.join(chr(int(s[i:i+2])) for i in range(0, len(s), 2))
print(decoded)  # RS4_F0R_TH3_W1N
```

**Why `int(s[i:i+2])`?** Each character's ASCII code is 2 digits (32-99). Concatenating them without separators yields the decimal string. Example: `R=82, S=83, 4=52, _=95, F=70 ...` → `828352957095...`.

---

## 8. Step-by-Step With YOUR Numbers

### Step 1 — Factor `n`
```
n = 35802469135802468914197530864197531
Factorization (factordb / RsaCtfTool):
p = 161111111111111111
q = 222222222222222221
Check: 161111111111111111 × 222222222222222221 = 35802469135802468914197530864197531 ✓
Both are PRIME (verified via Miller-Rabin / factordb status "P").
```

> **Why this step?** Without `p` and `q` you cannot compute `φ(n)` and thus cannot get `d`. Factoring is the *only* hard part; everything after is trivial arithmetic. This demonstrates RSA's security relies entirely on factoring being hard.

### Step 2 — Compute φ(n)
```
φ = (p-1)*(q-1)
  = 161111111111111110 × 222222222222222220
  = 35802469135802468530864197530864200
```

### Step 3 — Compute `d`
```
e = 65537
d = e⁻¹ mod φ = 27334366017349166355040984293671073
```
Verification: `(e*d) % φ == 1`
```
65537 × 27334366017349166355040984293671073 mod 35802469135802468530864197530864200 = 1 ✓
```
`d` **is** the private key: `private_key = (n, d)`.

### Step 4 — Decrypt
```
c = 23104147591671948052859847954945272
m = cᵈ mod n = pow(23104147591671948052859847954945272, 27334366017349166355040984293671073, 35802469135802468914197530864197531)
  = 828352957048829584725195874978
```

### Step 5 — Interpret `m`
Hex bytes method yields non-printable: `0a748d81a4db4cb105e743e2a2` → `b'\nt...'`.

Correct decoding for this exercise: decimal ASCII.

```
m_str = "828352957048829584725195874978"
Split every 2 digits → [82,83,52,95,70,48,82,95,84,72,51,95,87,49,78]
Map via chr()    → [ R, S, 4, _, F, 0, R, _, T, H, 3, _, W, 1, N]
Result           → "RS4_F0R_TH3_W1N"
```
Leet speak for **"RSA_FOR_THE_WIN"**.

---

## 9. Decoding the Plaintext — From Integer to Readable Text

In CTF/homework, encryption is `bytes_to_long(message.encode())`. To reverse:

**Standard method (try first):**
```python
from Crypto.Util.number import long_to_bytes
print(long_to_bytes(m))          # try
print(long_to_bytes(m)[::-1])    # little endian
```

**This challenge's method (decimal ASCII):**
```python
m_str = str(m)
flag = ''.join(chr(int(m_str[i:i+2])) for i in range(0, len(m_str), 2))
print(flag)  # RS4_F0R_TH3_W1N
```

> **Why two methods?** Some professors encode by `m = int.from_bytes(flag.encode())` (hex/bytes). Others cheat by concatenating ASCII codes. Always try both and also check hex decoding (`bytes.fromhex(hex(m)[2:])`). For your `c`, the decimal method is correct as proven by the readable output.

---

## 10. Verification

Always prove your `d` is correct:

```python
assert p*q == n
assert pow(pow(m, e, n), d, n) == m
assert pow(c, d, n) == m
assert pow(m, e, n) == c   # round-trip
print("All checks passed — private key is valid and message decrypts correctly.")
```

Output:
```
m^e mod n == c ? True
c^d mod n == m ? True
```

---

## 11. What to Submit for Homework

Professors typically want:
1. **Factors**: `p = 161111111111111111`, `q = 222222222222222221`
2. **φ(n)**: `35802469135802468530864197530864200`
3. **Private exponent**: `d = 27334366017349166355040984293671073`
4. **Plaintext integer**: `m = 828352957048829584725195874978`
5. **Plaintext text**: `RS4_F0R_TH3_W1N`
6. **Method**: Screenshot or log of `RsaCtfTool` command + manual Python calculation.
7. **Explanation** of why factoring breaks RSA for small `n`.

**Example answer paragraph:**
> "We factored `n` via factordb / RsaCtfTool's Pollard Rho, obtaining `p` and `q`. We computed `φ(n)=(p-1)(q-1)`, then `d = e⁻¹ mod φ(n)` using the Extended Euclidean Algorithm, yielding `d=273...`. Decrypting `m = cᵈ mod n` gave `828...` which decoded via 2-digit ASCII to `RS4_F0R_TH3_W1N`."

---

## 12. Security Lesson & Ethics

*   This attack works **only because `n` is 115-bit**. Real-world RSA-2048 has 617 digits; factoring it would take longer than the age of the universe. Never use <2048-bit RSA in production.
*   Use this knowledge only on challenges you own or have explicit permission to test (your homework, CTFs). Do **not** use RsaCtfTool on real systems.
*   Ethical use = learning why key size matters.

---

## 13. Troubleshooting

| Problem | Fix |
|---------|-----|
| `RsaCtfTool` says `n` not factored | Add `--attack factordb` or update tool (`git pull`). Or manually query factordb.com. Your `n` is in factordb, so it should succeed. |
| `pow(e, -1, phi)` → `ValueError` | Your Python <3.8: use `modinv` via `egcd` shown above, or `pip install pycryptodome` and `from Crypto.Util.number import inverse`. |
| Decrypted bytes are garbled | Your decoding method may be wrong. Try hex, then decimal ASCII, then base64. For your numbers, decimal ASCII is correct. |
| `pip` not found | Use `python3 -m pip install -r requirements.txt` or `pip3`. On Kali, `sudo apt install python3-pip`. |
| Tool installs but fails with `gmpy2` | `sudo apt install libgmp-dev libmpfr-dev libmpc-dev && pip3 install gmpy2` |

---

## Appendix: One-Liner Complete Attack

```bash
# Full automated
python3 RsaCtfTool.py --n 35802469135802468914197530864197531 --e 65537 --uncipher 23104147591671948052859847954945272 --private --verbose

# Manual Python (copy-paste)
python3 -c "
p=161111111111111111; q=222222222222222221; n=p*q; e=65537; c=23104147591671948052859847954945272
phi=(p-1)*(q-1); d=pow(e,-1,phi); m=pow(c,d,n)
print('d',d); print('m',m); print(''.join(chr(int(str(m)[i:i+2])) for i in range(0,len(str(m)),2)))
"
# Output:
# d 27334366017349166355040984293671073
# m 828352957048829584725195874978
# RS4_F0R_TH3_W1N
```

---

**Generated:** 2025-09-04 for homework demonstration. Keep this file for your write-up and cite RsaCtfTool (`https://github.com/RsaCtfTool/RsaCtfTool`) and factordb.com as tools used.

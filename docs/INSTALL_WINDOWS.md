# Windows setup (ngspice + Python)

The Windows setup below was smoke-tested with ngspice 47 x64 and Python 3.11.4.

1. Download the stable ngspice 47 Windows 64-bit archive from the [official ngspice download page](https://ngspice.sourceforge.io/download.html), verify the archive SHA-256 shown by the download page, and extract it to a directory you can keep, such as `C:\tools\ngspice-47`. For this tested archive, the executable is `Spice64\bin\ngspice_con.exe`.
2. Install Python 3.10 or later.
3. In PowerShell at the project root, create and install the Python environment:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -e .
   ```

4. Set the simulator path for this PowerShell session and check it:

   ```powershell
   $env:NGSPICE_EXE = 'C:\tools\ngspice-47\Spice64\bin\ngspice_con.exe'
   edastack doctor
   edastack verify examples/rc_filter/spec.json --out build/rc_filter
   edastack verify examples/diode_clamp/spec.json --out build/diode_clamp
   ```

   Use `ngspice_con.exe` for command-line runs. If Windows resolves the GUI `ngspice.exe` from `PATH` and its sibling console binary is present, EDA Stack automatically selects `ngspice_con.exe` to avoid the GUI's “no main window” setup notice in batch mode.

   To make the path available to new user sessions, run once:

   ```powershell
   [Environment]::SetEnvironmentVariable('NGSPICE_EXE', $env:NGSPICE_EXE, 'User')
   ```

5. Read `build/rc_filter/report.md` and `build/diode_clamp/report.md`; inspect scenario logs under each output directory if a check fails.

The real ngspice run and analytic RC comparison are recorded in `docs/REAL_NGSPICE_VALIDATION.md`. That evidence covers only the listed decks, models and scenarios; it is not hardware certification.

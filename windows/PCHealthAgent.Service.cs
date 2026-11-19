using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Timers;

namespace PCHealthAgent
{
    public class HealthService : ServiceBase
    {
        private const string ServiceNameValue = "PCHealthAgent";

        private readonly object _sync = new object();
        private readonly string _installDir;
        private readonly string _logPath;
        private Process _agentProcess;
        private Timer _watchdog;

        public static void Main()
        {
            ServiceBase.Run(new HealthService());
        }

        public HealthService()
        {
            ServiceName = ServiceNameValue;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;

            _installDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            _logPath = Path.Combine(_installDir, "service.log");
        }

        protected override void OnStart(string[] args)
        {
            WriteLog("service started");

            lock (_sync)
            {
                StartAgentInternal();
            }

            _watchdog = new Timer(10000);
            _watchdog.Elapsed += OnWatchdog;
            _watchdog.AutoReset = true;
            _watchdog.Start();
        }

        protected override void OnStop()
        {
            if (_watchdog != null)
            {
                _watchdog.Stop();
                _watchdog.Dispose();
                _watchdog = null;
            }

            lock (_sync)
            {
                StopAgentInternal();
            }

            WriteLog("service stopped");
        }

        protected override void OnShutdown()
        {
            OnStop();
        }

        private void OnWatchdog(object sender, ElapsedEventArgs e)
        {
            lock (_sync)
            {
                if (_agentProcess == null || _agentProcess.HasExited)
                {
                    WriteLog("agent not running, restarting");
                    StartAgentInternal();
                }
            }
        }

        private void StartAgentInternal()
        {
            try
            {
                string script = Path.Combine(_installDir, "agent.ps1");
                if (!File.Exists(script))
                {
                    WriteLog("agent.ps1 missing: " + script);
                    return;
                }

                string powershell = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell\\v1.0\\powershell.exe");
                if (!File.Exists(powershell)) powershell = "powershell.exe";

                var startInfo = new ProcessStartInfo();
                startInfo.FileName = powershell;
                startInfo.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"";
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;

                var process = new Process();
                process.StartInfo = startInfo;
                process.EnableRaisingEvents = true;
                process.OutputDataReceived += OnAgentOutput;
                process.ErrorDataReceived += OnAgentOutput;
                process.Exited += OnAgentExited;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                _agentProcess = process;
                WriteLog("agent started pid=" + process.Id);
            }
            catch (Exception ex)
            {
                WriteLog("failed to start agent: " + ex.Message);
            }
        }

        private void OnAgentOutput(object sender, DataReceivedEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Data)) WriteLog("agent: " + e.Data);
        }

        private void OnAgentExited(object sender, EventArgs e)
        {
            var process = sender as Process;
            WriteLog("agent exited code=" + (process != null ? process.ExitCode.ToString() : "unknown"));
        }

        private void StopAgentInternal()
        {
            try
            {
                if (_agentProcess != null && !_agentProcess.HasExited)
                {
                    _agentProcess.Kill();
                    _agentProcess.WaitForExit(5000);
                    WriteLog("agent stopped");
                }
            }
            catch (Exception ex)
            {
                WriteLog("failed to stop agent: " + ex.Message);
            }
            finally
            {
                _agentProcess = null;
            }
        }

        private void WriteLog(string message)
        {
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine;
                File.AppendAllText(_logPath, line);
            }
            catch
            {
                // Logging must never stop the service.
            }
        }
    }
}

// Tiny Windows stdio bridge. Python owns the protocol and database.
// Launch Python directly so CMD path lookup and quoting cannot interfere.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

internal static class Launcher {
    private static string Quote(string value) {
        if (value.IndexOf('"') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\r') >= 0)
            throw new ArgumentException("Invalid launcher path");
        int trailingSlashes = value.Length - value.TrimEnd('\\').Length;
        return "\"" + value + new string('\\', trailingSlashes) + "\"";
    }
    private static int Main() {
        try {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string[] config = File.ReadAllLines(Path.Combine(directory, "host-config.txt"), Encoding.UTF8);
            if (config.Length != 3) throw new InvalidDataException("Expected three configuration paths");
            var info = new ProcessStartInfo {
                FileName = config[0], Arguments = Quote(config[1]) + " --data-dir " + Quote(config[2]),
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var child = Process.Start(info)) {
                Task.Factory.StartNew(() => {
                    try {
                        Stream source = Console.OpenStandardInput();
                        Stream destination = child.StandardInput.BaseStream;
                        byte[] bytes = new byte[8192];
                        int size;
                        while ((size = source.Read(bytes, 0, bytes.Length)) > 0) {
                            destination.Write(bytes, 0, size);
                            destination.Flush();
                        }
                    }
                    catch (IOException) { }
                    finally { try { child.StandardInput.Close(); } catch (IOException) { } }
                });
                Task.Factory.StartNew(() => {
                    try { child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); }
                    catch (IOException) { }
                });
                Stream input = child.StandardOutput.BaseStream;
                Stream output = Console.OpenStandardOutput();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                    output.Write(buffer, 0, count);
                    output.Flush();
                }
                child.WaitForExit();
                return child.ExitCode;
            }
        } catch (Exception error) {
            try {
                byte[] message = Encoding.UTF8.GetBytes(error.Message);
                Console.OpenStandardError().Write(message, 0, message.Length);
            } catch { }
            return 1;
        }
    }
}

import tempfile,pathlib,subprocess,sys,socket,time,json,os,signal
root=pathlib.Path(tempfile.mkdtemp(prefix='canopy-tunnel-test-'))
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
child=root/'forward.py'
child.write_text('''import socket,sys,pathlib,time
p=pathlib.Path(sys.argv[2]); first=not p.exists(); p.write_text('started')
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen()
n=0
while True:
 c,_=s.accept(); c.recv(4096); n+=1
 if first and n>1: time.sleep(120)
 c.sendall(b'HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'); c.close()
''')
state=root/'state.json'; log=open(root/'log','w')
p=subprocess.Popen([sys.executable,'packages/remote-host/tunnel-supervisor.py','--port',str(port),'--state',str(state),'--',sys.executable,str(child),str(port),str(root/'started')],stdout=log,stderr=log)
seen_up=False;seen_down=False
try:
 until=time.monotonic()+70
 while time.monotonic()<until:
  if state.exists():
   phase=json.loads(state.read_text())['phase']
   if phase=='connected':
    if seen_down: print('PASS: stalled listener automatically restarted and traffic recovered');break
    seen_up=True
   if seen_up and phase=='reconnecting': seen_down=True
  time.sleep(.5)
 else: raise RuntimeError('Recovery was not completed')
finally:
 p.terminate();p.wait(timeout=10);log.close()
